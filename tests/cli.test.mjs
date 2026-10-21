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
      prompts.push({ label, defaultValue, secret })
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
  const f = fixture('remember', ['remember', 'host', '', 'user', '', 'ssh-secret', true, '/home/project', false])
  await f.cli.configure()
  assert(f.prompts.find(p => p.label.startsWith('SSH 登录密码')).secret)
  const persisted = fs.readFileSync(f.file, 'utf8')
  assert(!persisted.includes('ssh-secret'))
  assert.deepEqual(parseSshCommand(loadState(f.file).values.ssh), { host: 'host', port: 22, user: 'user', identity: undefined, extraOptions: [] })
  assert.equal(f.prompts.find(p => p.label === 'SSH 端口').defaultValue, '22')
  const next = new RemoteCLI(f.file, { text() { throw Error('must not prompt') } }, f.store, {}, () => {})
  const result = await next.connection()
  assert.equal(result.env.REMOTE_PASSWORD, 'ssh-secret')
  assert.equal(result.env.REMOTE_SUDO_PASSWORD, undefined)
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
})

test('wizard explains each step and retries empty required input with an example', async () => {
  const f = fixture('guidance', ['guidance', '', 'ssh user@host', '192.168.1.10', '0', '65536', '22x', '2222', '', 'user@host', 'alice', '3', '1', 'login', false, 'relative', '/work', false])
  await f.cli.configure()
  const output = f.output.join('\n')
  for (const step of ['[1/4]', '[2/4]', '[3/4]', '[4/4]']) assert(output.includes(step))
  assert(output.includes('192.168.1.10'))
  assert(output.includes('还没有填写服务器 IP / 主机名'))
  assert(output.includes('请只填写 IP 或主机名'))
  assert(output.includes('1 到 65535'))
  assert(output.includes('请输入 1（密码登录）或 2（SSH 密钥）'))
  assert(output.includes('输入时不会显示字符或星号'))
  assert(!f.prompts.some(p => p.label.includes('SSH 连接命令')))
  assert.equal(f.prompts.filter(p => p.label === '服务器 IP / 主机名（必填）').length, 3)
  const parsed = parseSshCommand(loadState(f.file).values.ssh)
  assert.equal(parsed.port, 2222)
  assert.equal(parsed.user, 'alice')
  assert(output.includes('登录方式：SSH 密码'))
  assert(output.includes('sudo 密码：不需要'))
})

test('unremembered passwords prompt on next launch; sudo credentials are independent', async () => {
  const f = fixture('prompt', ['prompt', 'host', '', 'user', '1', 'login', false, '/work', true, 'sudo-other', false])
  await f.cli.configure()
  assert.equal(f.store.values.size, 0)
  const next = fixture('prompt', ['new-login', 'new-sudo'])
  const result = await next.cli.connection()
  assert.equal(result.env.REMOTE_PASSWORD, 'new-login')
  assert.equal(result.env.REMOTE_SUDO_PASSWORD, 'new-sudo')
  assert.equal(next.prompts.length, 2)
})

test('wizard pre-fills existing connection fields and retains advanced SSH options when editing', async () => {
  const f = fixture('edit-connection', ['edit-connection', '', '', '', '', 'login', false, '', false])
  f.cli.state.values = { ssh: 'ssh -v -oHostKeyAlgorithms=+ssh-rsa -o "Ciphers=aes128-ctr,aes256-ctr" -J jump -p 2222 -l alice server', auth: 'password', workdir: '/saved' }
  await f.cli.configure()
  assert.deepEqual(f.prompts.slice(1, 4).map(p => p.defaultValue), ['server', '2222', 'alice'])
  const { values } = loadState(f.file)
  assert.equal(values.workdir, '/saved')
  assert(values.ssh.includes('-v'))
  assert(values.ssh.includes('-J jump'))
  assert.deepEqual(parseSshCommand(values.ssh), {
    host: 'server', port: 2222, user: 'alice', identity: undefined,
    extraOptions: ['-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'Ciphers=aes128-ctr,aes256-ctr'],
  })
  const edited = fixture('edit-connection', ['', 'new-host', '2200', 'bob', '', 'new-login', false, '', false])
  await edited.cli.configure()
  assert.deepEqual(parseSshCommand(loadState(f.file).values.ssh), {
    host: 'new-host', port: 2200, user: 'bob', identity: undefined,
    extraOptions: parseSshCommand(values.ssh).extraOptions,
  })
})

test('key wizard accepts a separate local path with spaces and retries missing or public key files', async () => {
  const key = path.join(temporary, 'my private key')
  fs.writeFileSync(key, 'synthetic-key-file')
  const f = fixture('key-wizard', ['key-wizard', '[2001:db8::1]', '', 'alice', '2', 'agent', `${key}.missing`, `${key}.pub`, temporary, key, '/work', false])
  await f.cli.configure()
  const parsed = parseSshCommand(loadState(f.file).values.ssh)
  assert.equal(parsed.host, '2001:db8::1')
  assert.equal(parsed.identity, key)
  assert(f.output.join('\n').includes('这是公钥文件'))
  assert(f.output.join('\n').includes('找不到可读取的私钥文件'))
  assert(f.output.join('\n').includes('当前终端没有 SSH agent'))
  assert(!f.prompts.some(p => p.secret))
  const next = fixture('key-wizard')
  assert.equal((await next.cli.connection()).env.REMOTE_PASSWORD, undefined)
  assert.equal(next.prompts.length, 0)
})

test('switching from key to password login removes the old identity and retains connection defaults', async () => {
  const f = fixture('key-to-password', ['key-to-password', '', '', '', '1', 'login', false, '', false])
  f.cli.state.values = { ssh: 'ssh -i /old/private-key -p 2222 user@host', workdir: '/work', auth: 'key' }
  await f.cli.configure()
  assert.equal(f.prompts.find(p => p.label.startsWith('认证方式')).defaultValue, '2')
  assert(f.output.join('\n').includes('2. SSH 密钥（默认）'))
  assert.equal(parseSshCommand(loadState(f.file).values.ssh).identity, undefined)
  assert.equal((await f.cli.connection()).env.REMOTE_PASSWORD, 'login')
})

test('key wizard supports SSH agent without a private key path or login password', async () => {
  const f = fixture('agent-wizard', ['agent-wizard', 'host', '', 'user', '2', 'agent', '/work', false], undefined, { SSH_AUTH_SOCK: '/test-agent' })
  await f.cli.configure()
  assert.equal(loadState(f.file).values.auth, 'key')
  assert.equal(parseSshCommand(loadState(f.file).values.ssh).identity, undefined)
  assert.equal((await f.cli.connection()).env.REMOTE_PASSWORD, undefined)
  assert(!f.prompts.some(p => p.secret))
})

test('cancelling a changed connection keeps previous connection values on disk', async () => {
  const f = fixture('cancel-edit', ['cancel-edit', 'new-host', '', 'new-user', '1', 'login', false])
  const saved = { ssh: 'ssh old-user@old-host', workdir: '/old', auth: 'password' }
  f.cli.state.values = saved
  f.cli.persist()
  // No workdir answer is supplied, simulating termination before completing the wizard.
  await assert.rejects(f.cli.configure(), /Unexpected prompt/)
  assert.deepEqual(loadState(f.file).values, saved)
})

test('legacy settings migrate into a named profile with directory and credential identity intact', async () => {
  const initial = fixture('migration')
  fs.mkdirSync(path.dirname(initial.file), { recursive: true })
  const ssh = 'ssh -p 2222 alice@legacy'
  const id = targetId(ssh)
  fs.writeFileSync(initial.file, JSON.stringify({ version: 1, values: { ssh, workdir: '/legacy', auth: 'password' }, credentials: { [id]: { ssh: true } } }))
  initial.store.values.set(`${id}:ssh`, 'legacy-secret')
  const migrated = fixture('migration', ['', ''], initial.store)
  assert.equal(migrated.cli.state.version, 2)
  assert.equal(migrated.cli.state.profiles[0].name, 'alice@legacy')
  const connection = await migrated.cli.connection(false, true)
  assert.equal(connection.values.workdir, '/legacy')
  assert.equal(connection.env.REMOTE_PASSWORD, 'legacy-secret')
  const saved = JSON.parse(fs.readFileSync(initial.file, 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.profiles.length, 1)
  assert.equal(saved.profiles[0].values.workdir, '/legacy')
  assert(!JSON.stringify(saved).includes('legacy-secret'))
})

function profiles(f) {
  f.cli.state.profiles = [
    { id: 'a', name: 'Server A', values: { ssh: 'ssh alice@host-a', workdir: '/project-a', auth: 'password' } },
    { id: 'b', name: 'Server B', values: { ssh: 'ssh bob@host-b', workdir: '/project-b', auth: 'password' } },
  ]
  f.cli.state.selected = 'a'
  for (const p of f.cli.state.profiles) f.cli.state.credentials[targetId(p.values.ssh)] = { ssh: false }
  f.cli.persist()
}

test('each launch selects a server and remembers its own directory without mixing passwords', async () => {
  const f = fixture('profiles', ['9', '2', '/new-b', 'password-b'])
  profiles(f)
  const b = await f.cli.connection(false, true)
  assert.equal(b.env.REMOTE_SSH, 'ssh bob@host-b')
  assert.equal(b.env.REMOTE_PASSWORD, 'password-b')
  assert.equal(b.values.workdir, '/new-b')
  assert.equal(loadState(f.file).selected, 'b')
  assert.equal(loadState(f.file).profiles[0].values.workdir, '/project-a')
  const next = fixture('profiles', ['1', '', 'password-a'])
  const a = await next.cli.connection(false, true)
  assert.equal(next.prompts[0].defaultValue, '2')
  assert.equal(next.prompts[1].defaultValue, '/project-a')
  assert.equal(a.env.REMOTE_PASSWORD, 'password-a')
  assert.equal(a.values.workdir, '/project-a')
  const again = fixture('profiles', ['2', '', 'password-b'])
  assert.equal((await again.cli.connection(false, true)).values.workdir, '/new-b')
})

test('new connection from launch menu keeps other profiles and asks directory only once', async () => {
  const f = fixture('new-profile', ['0', 'Server A', 'Server C', 'host-c', '', 'carol', '2', 'agent', '/project-c', false], undefined, { SSH_AUTH_SOCK: '/agent' })
  profiles(f)
  const result = await f.cli.connection(false, true)
  assert.equal(result.values.ssh, 'ssh -p 22 carol@host-c')
  assert.equal(f.cli.state.profiles.length, 3)
  assert.equal(f.cli.state.profiles[2].name, 'Server C')
  assert.equal(f.cli.state.profiles[0].values.workdir, '/project-a')
  assert.equal(f.prompts.filter(p => p.label.includes('工作目录')).length, 1)
  assert(f.output.join('\n').includes('这个名称已存在'))
})

test('management edits only chosen profile and deletion confirms without removing shared credentials', async () => {
  const f = fixture('manage', ['2', '2', 'Renamed B', '', '', '', '', 'new-password', false, '', false])
  profiles(f)
  await f.cli.configCommand([])
  assert.equal(loadState(f.file).profiles[1].name, 'Renamed B')
  assert.equal(loadState(f.file).profiles[0].name, 'Server A')
  const cancel = fixture('manage', ['3', '2', false])
  await cancel.cli.configCommand([])
  assert.equal(loadState(f.file).profiles.length, 2)
  const remove = fixture('manage', ['3', '2', true])
  const credentials = loadState(f.file).credentials
  await remove.cli.configCommand([])
  assert.equal(loadState(f.file).selected, 'a')
  assert.deepEqual(loadState(f.file).credentials, credentials)
  assert.equal(loadState(f.file).profiles.length, 1)
})

test('automation specifies target explicitly and never overwrites another server directory', async () => {
  const f = fixture('profile-env', [], undefined, { REMOTE_SSH: 'ssh robot@automated', REMOTE_WORKDIR: '/job', REMOTE_PASSWORD: 'env-secret' })
  profiles(f)
  const before = fs.readFileSync(f.file, 'utf8')
  const result = await f.cli.connection(false, true)
  assert.equal(result.values.workdir, '/job')
  assert.equal(result.env.REMOTE_PASSWORD, 'env-secret')
  assert.equal(f.prompts.length, 0)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  const ambiguous = fixture('profile-env')
  await assert.rejects(ambiguous.cli.connection(false, false), /多个连接需要交互选择/)
})

test('a saved connection without a directory prompts for it without restarting setup', async () => {
  const f = fixture('missing-dir', ['', '', 'relative', '/first', 'password'])
  profiles(f)
  delete f.cli.state.profiles[0].values.workdir
  const result = await f.cli.connection(false, true)
  assert.equal(result.values.workdir, '/first')
  assert.equal(f.prompts.filter(p => p.label.includes('工作目录')).length, 3)
  assert(!f.prompts.some(p => p.label === '连接名称'))
})

test('cancelling directory entry does not change the saved selected server', async () => {
  const f = fixture('cancel-selection', ['2'])
  profiles(f)
  const before = fs.readFileSync(f.file, 'utf8')
  await assert.rejects(f.cli.connection(false, true), /Unexpected prompt/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
})

test('first named connection preserves preconfigured pool defaults', async () => {
  const f = fixture('draft-defaults', ['First', 'host', '', 'alice', '2', 'agent', '/work', false], undefined, { SSH_AUTH_SOCK: '/agent' })
  await f.cli.configCommand(['set', 'pool-command-size', '1'])
  await f.cli.configCommand(['new'])
  assert.equal(loadState(f.file).profiles[0].values['pool-command-size'], 1)
  assert.deepEqual(loadState(f.file).defaults, {})
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
