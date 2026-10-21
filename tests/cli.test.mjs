import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { RemoteCLI } from '../dist/cli/index.js'
import { effective, loadState, validate, targetId, childEnvironment, sessionDirectory } from '../dist/cli/settings.js'
import { checkRemote } from '../dist/cli/runtime.js'
import { parseSshCommand, normalizeSshCommand, loadConfig } from '../dist/config.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const artifacts = path.join(root, 'tmp_test_artifacts')
fs.mkdirSync(artifacts, { recursive: true })
const temporary = fs.mkdtempSync(path.join(artifacts, 'cli-'))
after(() => fs.rmSync(temporary, { recursive: true, force: true }))
const require = createRequire(import.meta.url)
const { Server } = ssh2
const { registerPlugin, unregisterPlugin } = require('../scripts/setup.cjs')

class MemoryCredentials {
  values = new Map()
  async get(id, kind) { return this.values.get(`${id}:${kind}`) ?? null }
  async set(id, kind, password) { this.values.set(`${id}:${kind}`, password) }
  async remove(id, kind) { this.values.delete(`${id}:${kind}`) }
}

function fixture(name, answers = [], store = new MemoryCredentials(), env = {}) {
  const output = []
  const prompts = []
  const queue = [...answers]
  const prompt = {
    async text(label, defaultValue, secret) {
      prompts.push({ label, secret })
      assert(queue.length, `Unexpected prompt: ${label}`)
      return queue.shift() || defaultValue || ''
    },
    async confirm(label) {
      prompts.push({ label })
      assert(queue.length, `Unexpected confirmation: ${label}`)
      return queue.shift()
    },
  }
  const file = path.join(temporary, name, 'config.json')
  return { cli: new RemoteCLI(file, prompt, store, env, line => output.push(line)), file, output, prompts, store }
}

test('password login works without sudo, saves no plaintext, and reuses remembered credentials', async () => {
  const f = fixture('remember', ['ssh user@host', '/home/project', '1', false, 'ssh-secret', true])
  await f.cli.configure()
  assert(f.prompts.find(p => p.label.startsWith('SSH 登录密码')).secret)
  const persisted = fs.readFileSync(f.file, 'utf8')
  assert(!persisted.includes('ssh-secret'))
  const next = new RemoteCLI(f.file, { text() { throw Error('must not prompt') } }, f.store, {}, () => {})
  const result = await next.connection()
  assert.equal(result.env.REMOTE_PASSWORD, 'ssh-secret')
  assert.equal(result.env.REMOTE_SUDO_PASSWORD, undefined)
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
})

test('wizard explains each step and retries empty required input with an example', async () => {
  const f = fixture('guidance', ['', 'ssh user@host', '/work', '1', false, 'login', false])
  await f.cli.configure()
  const output = f.output.join('\n')
  for (const step of ['[1/4]', '[2/4]', '[3/4]', '[4/4]']) assert(output.includes(step))
  assert(output.includes('ssh alice@192.168.1.10'))
  assert(output.includes('还没有填写SSH 连接命令'))
  assert(output.includes('输入时不会显示字符或星号'))
  assert(!output.includes('ssh 不能为空'))
  assert.equal(f.prompts.filter(p => p.label === 'SSH 连接命令（必填）').length, 2)
  assert(output.includes('登录方式：SSH 密码'))
  assert(output.includes('sudo 密码：不需要'))
})

test('unremembered passwords prompt on next launch; sudo credentials are independent', async () => {
  const f = fixture('prompt', ['ssh user@host', '/work', '1', true, 'login', false, 'sudo-other', false])
  await f.cli.configure()
  assert.equal(f.store.values.size, 0)
  const next = fixture('prompt', ['new-login', 'new-sudo'])
  const result = await next.cli.connection()
  assert.equal(result.env.REMOTE_PASSWORD, 'new-login')
  assert.equal(result.env.REMOTE_SUDO_PASSWORD, 'new-sudo')
  assert.equal(next.prompts.length, 2)
})

test('changing host, account, or port cannot retrieve another target password', async () => {
  const f = fixture('targets', ['password-a', true, 'password-b', false])
  f.cli.state.values = { ssh: 'ssh alice@host', workdir: '/work', auth: 'password' }
  const first = await f.cli.connection()
  assert.equal(first.env.REMOTE_PASSWORD, 'password-a')
  await f.cli.configCommand(['set', 'ssh', 'ssh bob@host'])
  const second = await f.cli.connection()
  assert.equal(second.env.REMOTE_PASSWORD, 'password-b')
  const ids = ['ssh alice@host', 'ssh bob@host', 'ssh -p 2222 alice@host', 'ssh alice@other'].map(targetId)
  assert.equal(new Set(ids).size, 4)
  assert.equal(targetId('ssh -p 22 alice@HOST'), ids[0])
})

test('unavailable credential service permits this connection and never writes plaintext', async () => {
  const store = new MemoryCredentials()
  store.set = async () => { throw Object.assign(Error('unavailable'), { code: 'CREDENTIAL_SERVICE_UNAVAILABLE' }) }
  const f = fixture('locked', ['ephemeral', true], store)
  f.cli.state.values = { ssh: 'ssh user@host', workdir: '/work' }
  const result = await f.cli.connection()
  assert.equal(result.env.REMOTE_PASSWORD, 'ephemeral')
  assert(f.output.some(line => line.includes('不会写入明文')))
  assert(!fs.readFileSync(f.file, 'utf8').includes('ephemeral'))
  store.remove = async () => { throw Error('must not delete an entry that was never created') }
  await f.cli.configCommand(['forget-password'])
})

test('environment overrides saved values and secrets without persisting them', async () => {
  const env = { REMOTE_SSH: 'ssh other@host', REMOTE_WORKDIR: '/env', REMOTE_PASSWORD: 'env-login', REMOTE_SUDO_PASSWORD: 'env-sudo' }
  const f = fixture('env', [], undefined, env)
  f.cli.state.values = { ssh: 'ssh saved@host', workdir: '/saved', sudo: false }
  f.cli.persist()
  const result = await f.cli.connection()
  assert.equal(result.values.workdir, '/env')
  assert.equal(result.env.REMOTE_PASSWORD, 'env-login')
  assert.equal(result.env.REMOTE_SUDO_PASSWORD, 'env-sudo')
  f.cli.show()
  assert(!f.output.join('\n').includes('env-login'))
  assert(!f.output.join('\n').includes('env-sudo'))
  assert(!fs.readFileSync(f.file, 'utf8').includes('env-'))
})

test('key authentication skips login passwords and explicit sudo=false suppresses stale credentials', async () => {
  const f = fixture('key', [], undefined, {
    SSH_AUTH_SOCK: '/test-agent', REMOTE_PASSWORD: 'unused-login',
    REMOTE_SUDO_PASSWORD: 'unused-sudo', REMOTE_SUDO: 'false',
  })
  f.cli.state.values = { ssh: 'ssh user@host', workdir: '/work', auth: 'key', sudo: true }
  f.store.get = async () => { throw Error('must not access passwords') }
  const result = await f.cli.connection()
  assert.equal(result.env.REMOTE_PASSWORD, undefined)
  assert.equal(result.env.REMOTE_SUDO_PASSWORD, undefined)
  assert.equal(f.prompts.length, 0)
})

test('config updates validate values; unset restores defaults', async () => {
  const f = fixture('set')
  await f.cli.configCommand(['set', 'pool-command-size', '2'])
  assert.equal(loadState(f.file).values['pool-command-size'], 2)
  await f.cli.configCommand(['unset', 'pool-command-size'])
  assert.equal(effective(loadState(f.file), {}).values['pool-command-size'], 3)
  for (const [key, value] of [['sudo', 'yes'], ['auth', 'other'], ['workdir', '../x'], ['pool-file-size', '0'], ['pool-stagger-ms', '2ms'], ['ssh', 'ssh -p 22x user@host']]) {
    assert.throws(() => validate(key, value))
  }
  await assert.rejects(f.cli.configCommand(['set', 'password', 'must-not-save']))
  assert(!fs.readFileSync(f.file, 'utf8').includes('must-not-save'))
})

test('forget removes all tracked targets; failed deletion preserves indexes for retry', async () => {
  const f = fixture('forget')
  const a = targetId('ssh a@host'), b = targetId('ssh b@host')
  f.cli.state.credentials = { [a]: { ssh: true, sudo: true }, [b]: { ssh: true } }
  f.cli.persist()
  const remove = f.store.remove.bind(f.store)
  f.store.remove = async (id, kind) => { if (id === b) throw Error('locked'); await remove(id, kind) }
  await assert.rejects(f.cli.configCommand(['forget-password']), /未能删除/)
  assert.deepEqual(loadState(f.file).credentials, { [b]: { ssh: true } })
  f.store.remove = remove
  await f.cli.configCommand(['forget-password'])
  assert.deepEqual(loadState(f.file).credentials, {})
})

test('reset confirms and preserves history; refusal leaves settings intact', async () => {
  const f = fixture('reset', [false, true])
  f.cli.state.values = { ssh: 'ssh user@host', workdir: '/work' }
  f.cli.persist()
  const history = path.join(path.dirname(f.file), 'history.txt')
  fs.writeFileSync(history, 'keep')
  await f.cli.configCommand(['reset'])
  assert(fs.existsSync(f.file))
  await f.cli.configCommand(['reset'])
  assert(!fs.existsSync(f.file))
  assert.equal(fs.readFileSync(history, 'utf8'), 'keep')
})

test('malformed configuration errors do not expose contents or overwrite the file', () => {
  const file = path.join(temporary, 'broken.json')
  fs.writeFileSync(file, '{"password":"do-not-echo",')
  assert.throws(() => loadState(file), error => !error.message.includes('do-not-echo'))
  assert.equal(fs.readFileSync(file, 'utf8'), '{"password":"do-not-echo",')
})

test('SSH parsing supports quoted key paths, tilde, usernames and IPv6; shell text remains data', () => {
  assert.equal(parseSshCommand('ssh -i "/tmp/my key" -p 2222 user@host').identity, path.resolve('/tmp/my key'))
  assert.equal(parseSshCommand('ssh -v -l me host').user, 'me')
  assert.equal(parseSshCommand('ssh me@2001:db8::1').host, '2001:db8::1')
  assert.throws(() => parseSshCommand('ssh -i "unfinished'))
  const normalized = normalizeSshCommand('ssh -i "./my key" user@host')
  assert.equal(parseSshCommand(normalized).identity, path.join(root, 'my key'))
  assert.equal(normalizeSshCommand(normalized), normalized)
  assert.equal(parseSshCommand('ssh -i ' + JSON.stringify(path.join(root, 'back\\slash key')) + ' user@host').identity, path.join(root, 'back\\slash key'))
  assert(sessionDirectory({ ssh: 'ssh user@host', workdir: '/home/project' }, temporary).endsWith('host_home_project'))
  assert.equal(sessionDirectory({ ssh: 'ssh user@host', workdir: '/a/../../escape' }, temporary).startsWith(temporary), true)
  assert.deepEqual(childEnvironment({ auth: 'key', sudo: false }, {}, { REMOTE_PASSWORD: 'old', REMOTE_SUDO_PASSWORD: 'old' }), { REMOTE_AUTH: 'key', REMOTE_SUDO: 'false' })
})

test('plugin registration is repeatable, loads the server function, and protects unrelated files', async () => {
  const config = path.join(temporary, 'plugin config with spaces')
  const file = registerPlugin(config)
  const content = fs.readFileSync(file, 'utf8')
  registerPlugin(config)
  assert.equal(fs.readFileSync(file, 'utf8'), content)
  fs.writeFileSync(path.join(config, 'plugins', 'package.json'), '{"type":"module"}')
  const entry = await import(pathToFileURL(file).href)
  assert.equal(typeof entry.default, 'function')
  unregisterPlugin(config)
  fs.writeFileSync(file, '// user plugin')
  assert.throws(() => registerPlugin(config), /非本安装器/)
  assert.throws(() => unregisterPlugin(config), /非本安装器/)
  assert.equal(fs.readFileSync(file, 'utf8'), '// user plugin')
})

test('built CLI works from another directory; missing noninteractive credentials fail promptly', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('REMOTE_')))
  env.XDG_CONFIG_HOME = path.join(temporary, 'subprocess-config')
  const entry = path.join(root, 'bin/opencode-remote.cjs')
  const run = args => spawnSync(process.execPath, [entry, ...args], { cwd: temporary, env, encoding: 'utf8', timeout: 5000 })
  assert.equal(run(['--version']).stdout.trim(), require('../package.json').version)
  assert(run(['--help']).stdout.includes('opencode-remote doctor'))
  assert.equal(run(['config', 'set', 'ssh', 'ssh user@host']).status, 0)
  assert.equal(run(['config', 'set', 'workdir', '/work']).status, 0)
  assert(run(['config', 'show']).stdout.includes('/work'))
  const missing = run(['config'])
  assert.equal(missing.status, 1)
  assert(missing.stderr.includes('需要交互输入'))
})

test('launch forwards literal arguments, credentials and exit code, keeping cwd stable', { skip: process.platform === 'win32' }, () => {
  const base = path.join(temporary, 'launch')
  const bin = path.join(base, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const capture = path.join(base, 'capture.json')
  fs.writeFileSync(path.join(bin, 'opencode'), `#!${process.execPath}\n
    import fs from 'node:fs'
    if (process.argv[2] === '--version') { console.log('test-host'); process.exit(0) }
    fs.writeFileSync(process.env.TEST_REMOTE_CAPTURE, JSON.stringify({
      cwd: process.cwd(), args: process.argv.slice(2), password: process.env.REMOTE_PASSWORD,
      sudo: process.env.REMOTE_SUDO_PASSWORD,
    }))
    process.exit(42)
  `, { mode: 0o755 })
  const preload = path.join(base, 'home.cjs')
  // Isolate session files without changing HOME or the user's real settings.
  fs.writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(base)}`)
  const config = path.join(base, 'opencode')
  registerPlugin(config)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('REMOTE_')))
  Object.assign(env, {
    PATH: bin + path.delimiter + process.env.PATH,
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    XDG_CONFIG_HOME: path.join(base, 'config'), OPENCODE_CONFIG_DIR: config,
    REMOTE_SSH: 'ssh test@host', REMOTE_WORKDIR: '/work', REMOTE_PASSWORD: 'runtime-only',
    TEST_REMOTE_CAPTURE: capture,
  })
  const args = ['run', 'a b', 'x$HOME; $(literal)']
  const entry = path.join(root, 'bin/opencode-remote.cjs')
  let previous
  for (const cwd of [base, temporary]) {
    const result = spawnSync(process.execPath, [entry, '--', ...args], { env, cwd, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 42, result.stderr)
    assert(!result.stdout.includes('runtime-only'))
    const saved = JSON.parse(fs.readFileSync(capture, 'utf8'))
    assert.deepEqual(saved.args, args)
    assert.equal(saved.password, 'runtime-only')
    assert.equal(saved.sudo, undefined)
    if (previous) assert.equal(saved.cwd, previous)
    previous = saved.cwd
  }
  assert(previous.startsWith(base))
})

test('plugin configuration reads REMOTE_SUDO_PASSWORD and ignores unsupported remote CLI flags', () => {
  const previousEnv = { ...process.env }, previousArgs = process.argv
  try {
    process.argv = ['node', 'opencode', '--remote', 'ssh cli@host']
    delete process.env.REMOTE_SSH
    assert.equal(loadConfig(), null)
    process.env.REMOTE_SSH = 'ssh env@host'
    process.env.REMOTE_WORKDIR = '/work'
    process.env.REMOTE_SUDO_PASSWORD = 'sudo-test'
    assert.equal(loadConfig().sudoPassword, 'sudo-test')
    assert.equal(loadConfig().user, 'env')
  } finally { process.env = previousEnv; process.argv = previousArgs }
})

test('doctor authenticates over SSH and quotes remote directory without executing sudo', async () => {
  // Use a disposable key for the in-process SSH test server.
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const commands = []
  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {})
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test-password') ctx.accept()
      else ctx.reject()
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command)
        const stream = accept()
        stream.exit(info.command.includes('/missing') ? 1 : 0)
        stream.end()
      })
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ssh = `ssh -p ${server.address().port} test@127.0.0.1`
  try {
    await checkRemote({ ssh, workdir: "/tmp/a'; touch /tmp/never" }, { REMOTE_PASSWORD: 'test-password' })
    assert(commands[0].includes("'\"'\"'"))
    assert(!commands[0].includes('sudo'))
    await assert.rejects(checkRemote({ ssh, workdir: '/missing' }, { REMOTE_PASSWORD: 'test-password' }), /不可访问/)
    await assert.rejects(checkRemote({ ssh, workdir: '/work' }, { REMOTE_PASSWORD: 'wrong' }), /SSH 连接失败/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
