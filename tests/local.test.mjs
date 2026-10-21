import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadLocalSettings, saveLocalSettings, validateWindowsCli } from '../dist/local-settings.js'
import { createLocalTools } from '../dist/tools/local.js'
import { createTransferTool, remoteTransferPath } from '../dist/tools/transfer.js'
import { runLocal, localPath, isWsl, runWindows } from '../dist/local-runtime.js'
import { buildRemoteSystemPrompt } from '../dist/remote-system-prompt.js'
import { RemoteCLI } from '../dist/cli/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await fs.mkdtemp(path.join(root, 'tmp_test_artifacts', 'local-tools-'))
after(() => fs.rm(temp, { recursive: true, force: true }))
const globalFile = path.join(temp, 'global.json')
const permissions = []
const ctx = () => ({ abort: new AbortController().signal, ask: async request => { permissions.push(request) } })

test('global names validate, deduplicate, persist separately, and survive server reset', async () => {
  assert.deepEqual(validateWindowsCli(['DocFetch', 'docfetch', 'gh.exe']), ['docfetch', 'gh.exe'])
  for (const input of [['C:\\Tools\\cli.exe'], ['cli --help'], ['cli;whoami'], ['../cli'], ['*']]) assert.throws(() => validateWindowsCli(input))
  saveLocalSettings(['DocFetch'], globalFile)
  const file = path.join(temp, 'config.json')
  const cli = new RemoteCLI(file, { confirm: async () => true }, { remove: async () => {} }, {}, () => {})
  await cli.configCommand(['set', 'ssh', 'ssh user@host'])
  await cli.configCommand(['reset'])
  assert.deepEqual(loadLocalSettings(globalFile).windowsCli, ['docfetch'])
  await cli.configCommand(['windows-cli', 'set', 'one,two', 'three'])
  assert.deepEqual(loadLocalSettings(globalFile).windowsCli, ['one','two','three'])
  await cli.configCommand(['windows-cli', 'clear'])
  assert.deepEqual(loadLocalSettings(globalFile).windowsCli, [])
  await fs.writeFile(globalFile, '{"secret":"do-not-echo",')
  assert.throws(() => loadLocalSettings(globalFile), error => !error.message.includes('do-not-echo'))
  saveLocalSettings([], globalFile)
})

test('local execution forwards literal args, bounds output, fails on exit, and handles cancellation', async () => {
  const input = "a b ' ; $(not-a-command)"
  const result = await runLocal(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', input])
  assert.equal(result, input)
  const large = await runLocal(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'])
  assert(large.length < 66000)
  assert(large.includes('truncated'))
  await assert.rejects(runLocal(process.execPath, ['-e','process.exit(7)']), /code 7/)
  await assert.rejects(runLocal(process.execPath, ['-e','setInterval(()=>{},1000)'], { timeout: 20 }), /timed out/)
  const controller = new AbortController()
  const pending = runLocal(process.execPath, ['-e','setInterval(()=>{},1000)'], { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /cancelled/)
})

test('local programs do not inherit remote SSH credentials', async () => {
  const script = `import {runLocal} from ${JSON.stringify(new URL('../dist/local-runtime.js', import.meta.url).href)}; console.log(await runLocal(process.execPath,['-e','console.log(Boolean(process.env.REMOTE_PASSWORD || process.env.REMOTE_SUDO_PASSWORD))']));`
  const child = spawnSync(process.execPath, ['--input-type=module','-e',script], { env: { ...process.env, REMOTE_PASSWORD: 'synthetic-login', REMOTE_SUDO_PASSWORD: 'synthetic-sudo' }, encoding: 'utf8' })
  assert.equal(child.status, 0)
  assert.equal(child.stdout.trim(), 'false')
})

test('remote bash rejects a direct invocation of a configured Windows CLI', async () => {
  const config = path.join(temp, 'routing-config')
  saveLocalSettings(['docfetch'], path.join(config,'opencode-remote','global.json'))
  const script = `import assert from 'node:assert/strict'; import {createBashTool} from ${JSON.stringify(new URL('../dist/tools/bash.js', import.meta.url).href)}; const tool=createBashTool({exec:async()=>{throw Error('remote execution should not happen')}},'/work'); await assert.rejects(tool.execute({command:'docfetch --help'},{}), /Use local_cli/);`
  const child = spawnSync(process.execPath, ['--input-type=module','-e',script], { env: { ...process.env, XDG_CONFIG_HOME: config }, encoding:'utf8' })
  assert.equal(child.status, 0, child.stderr)
})

test('local_read is permissioned, paginated, and rejects binary/relative paths', async () => {
  const tools = createLocalTools(globalFile)
  const file = path.join(temp, 'reference.txt')
  await fs.writeFile(file, 'first\nsecond\nthird')
  const result = await tools.local_read.execute({ path: file, offset: 2, limit: 1 }, ctx())
  assert(result.includes('2: second'))
  assert(!result.includes('1: first'))
  assert.equal(permissions.at(-1).permission, 'local_read')
  await assert.rejects(tools.local_read.execute({ path: file }, { ...ctx(), ask: async () => { throw Error('denied') } }), /denied/)
  await fs.writeFile(file, Buffer.from([0, 1, 2]))
  await assert.rejects(tools.local_read.execute({ path: file }, ctx()), /Binary/)
  await assert.rejects(localPath('../relative'), /absolute/)
  await assert.rejects(tools.local_cli.execute({ name: 'unconfigured', args: [] }, ctx()), /not in global/)
})

test('system prompt separates local/remote locations and preserves skill usage instructions', async () => {
  const result = (await buildRemoteSystemPrompt({ modelID: 'default', remoteHost: 'server-a', remoteWorkdir: "/work/o'ne", remotePlatform: 'linux', isGitRepo: false, localPlatform: 'WSL', localHome: '/home/test', windowsCli: ['docfetch'], sshPool: { exec: async command => { assert(command.includes("'\\''")); return { stdout: '__NO_AGENTS_MD__' } } } }, ['<skills_instructions>Read local SKILL.md for command usage</skills_instructions>'])).join('\n')
  for (const text of ['PRIMARY', 'local_cli','local_read','upload','download','docfetch','Read local SKILL.md','WSL','server-a']) {
    assert(result.toLowerCase().includes(text.toLowerCase()), text)
  }
})

// Filesystem-backed SFTP adapter exercises complete copy plans and failure paths without external hosts.
const remoteRoot = path.join(temp, 'remote')
await fs.mkdir(remoteRoot)
const rp = value => path.join(remoteRoot, value.replace(/^\//,''))
const callback = (promise, cb) => { promise.then(value => cb(undefined,value), error => cb(error)) }
const sftp = {
  lstat(file, cb) { callback(fs.lstat(rp(file)), cb) },
  readdir(file, cb) { callback(fs.readdir(rp(file)).then(names => names.map(filename => ({ filename }))), cb) },
  mkdir(file, cb) { callback(fs.mkdir(rp(file)), cb) },
  fastPut(from, to, cb) { callback(fs.copyFile(from, rp(to)), cb) },
  fastGet(from, to, cb) { callback(fs.copyFile(rp(from), to), cb) },
  rename(from, to, cb) { callback(fs.link(rp(from), rp(to)).then(() => fs.unlink(rp(from))), cb) },
  ext_openssh_rename(from, to, cb) { callback(fs.rename(rp(from), rp(to)), cb) },
  unlink(file, cb) { callback(fs.unlink(rp(file)), cb) },
  end() {},
}
const pool = { withSftp: async fn => fn(sftp) }
const upload = createTransferTool('upload', pool, '/work', 'test-host')
const download = createTransferTool('download', pool, '/work', 'test-host')

test('binary upload/download and directory copies preserve bytes without touching source', async () => {
  const source = path.join(temp, 'source folder')
  await fs.mkdir(path.join(source,'nested'), { recursive: true })
  const bytes = Buffer.from([0,255,128,13,10,42])
  await fs.writeFile(path.join(source,'nested','file.bin'), bytes)
  await fs.mkdir(path.join(source, 'empty'))
  const result = await upload.execute({ localPath: source, remotePath: '/work/tree', recursive: true }, ctx())
  assert.equal(result.metadata.files, 1)
  assert.deepEqual(await fs.readFile(rp('/work/tree/nested/file.bin')), bytes)
  const target = path.join(temp, 'download folder')
  await download.execute({ localPath: target, remotePath: '/work/tree', recursive: true }, ctx())
  assert.deepEqual(await fs.readFile(path.join(target,'nested','file.bin')), bytes)
  assert((await fs.stat(path.join(target,'empty'))).isDirectory())
  assert.deepEqual(await fs.readFile(path.join(source,'nested','file.bin')), bytes)
})

test('overwrite is explicit, permission denial causes no writes, and workspace escapes are rejected', async () => {
  const file = path.join(temp, 'replacement.txt')
  await fs.writeFile(file, 'new')
  await assert.rejects(upload.execute({ localPath: file, remotePath: '/work/tree/nested/file.bin' }, ctx()), /overwrite=true/)
  await assert.rejects(upload.execute({ localPath: file, remotePath: '/work/denied' }, { ...ctx(), ask: async () => { throw Error('denied') } }), /denied/)
  await assert.rejects(fs.stat(rp('/work/denied')), /ENOENT/)
  await upload.execute({ localPath: file, remotePath: '/work/tree/nested/file.bin', overwrite: true }, ctx())
  assert.equal(await fs.readFile(rp('/work/tree/nested/file.bin'),'utf8'), 'new')
  const permission = permissions.at(-1)
  assert.deepEqual(permission.metadata.overwrite, ['/work/tree/nested/file.bin'])
  await download.execute({ localPath: file, remotePath: '/work/tree/nested/file.bin', overwrite: true }, ctx())
  assert.throws(() => remoteTransferPath('../outside', '/work'), /workspace/)
  assert.equal(remoteTransferPath('/a', '/'), '/a')
  await assert.rejects(upload.execute({ localPath: temp, remotePath: '/work/no-recursive' }, ctx()), /recursive=true/)
})

test('failed atomic remote overwrite preserves the old destination', async () => {
  const file = path.join(temp, 'replacement.txt')
  const destination = '/work/tree/nested/file.bin'
  const before = await fs.readFile(rp(destination))
  const failingPool = { withSftp: async fn => fn({ ...sftp, ext_openssh_rename(from,to,cb) { cb(Error('unsupported extension')) } }) }
  await assert.rejects(createTransferTool('upload', failingPool, '/work','host').execute({ localPath: file, remotePath: destination, overwrite: true }, ctx()), /Atomic overwrite unavailable/)
  assert.deepEqual(await fs.readFile(rp(destination)), before)
  assert(!(await fs.readdir(rp('/work/tree/nested'))).some(name => name.endsWith('.tmp')))
  await assert.rejects(download.execute({ localPath: file, remotePath: destination }, ctx()), /overwrite=true/)
})

test('transfers refuse symlinks and clean staging files after failure', { skip: process.platform === 'win32' }, async () => {
  await fs.symlink('/tmp', rp('/work/link'))
  const file = path.join(temp, 'replacement.txt')
  await assert.rejects(upload.execute({ localPath: file, remotePath: '/work/link/escape' }, ctx()), /symlink/)
  await fs.symlink(file, path.join(temp,'link'))
  await assert.rejects(upload.execute({ localPath: path.join(temp,'link'), remotePath: '/work/refused' }, ctx()), /symlinks/)
  const failingPool = { withSftp: async fn => fn({ ...sftp, fastPut(from,to,cb) { callback(fs.writeFile(rp(to),'partial').then(() => { throw Error('connection failed') }), cb) } }) }
  await assert.rejects(createTransferTool('upload', failingPool, '/work','host').execute({ localPath: file, remotePath: '/work/failure' }, ctx()), /0\/1 files/)
  assert(!(await fs.readdir(rp('/work'))).some(name => name.endsWith('.tmp')))
  await assert.rejects(fs.stat(rp('/work/failure')), /ENOENT/)
})

test('Windows execution and WSL path conversion work without shell interpolation of arguments', { skip: process.platform !== 'win32' && !isWsl() }, async () => {
  saveLocalSettings(['where.exe'], globalFile)
  const routed = await createLocalTools(globalFile).local_cli.execute({ name: 'where.exe', args: ['powershell.exe'] }, ctx())
  assert(routed.output.includes('powershell.exe'))
  assert.equal(routed.metadata.location, 'local-windows')
  const output = await runWindows({ command: '[Console]::Write("windows-local-ok")' })
  assert(output.includes('windows-local-ok'))
  if (isWsl()) {
    const windows = (await runLocal('wslpath', ['-w',temp])).trim()
    // WSL UNC paths describe Linux files; drive paths map to actual mounted Windows volumes.
    assert(windows.includes('wsl'))
    const drive = await localPath('C:\\Windows\\System32')
    assert((await fs.stat(drive)).isDirectory())
  }
  const payload = "spaces and 'quotes' ; $(Write-Output injected)"
  const script = path.join(temp,'literal-args.ps1')
  await fs.writeFile(script, '[Console]::Write($args[0])')
  // Register only names, resolved from Windows PATH; direct script invocation is tested via PowerShell locally.
  const winpath = isWsl() ? (await runLocal('wslpath',['-w',script])).trim() : script
  const literal = await runWindows({ command: `& '${winpath.replaceAll("'", "''")}' '${payload.replaceAll("'", "''")}'` })
  assert(literal.includes(payload))
})

test('real SSH/SFTP transport uploads and downloads a binary file', { timeout: 15000 }, async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const { default: ssh2 } = await import('ssh2')
  const disk = path.join(temp, 'sftp-server')
  await fs.mkdir(disk)
  const serverPath = name => {
    const resolved = path.resolve(disk, '.' + name)
    if (resolved !== disk && !resolved.startsWith(disk + path.sep)) throw Error('outside test root')
    return resolved
  }
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type:'pkcs1', format:'pem' })
  const clients = new Set(), handles = new Map()
  let handleId = 0
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.on('authentication', c => c.accept()).on('ready', () => client.on('session', accept => {
      accept().on('sftp', acceptSftp => {
        const stream = acceptSftp()
        const error = (id, e) => stream.status(id, e.code === 'ENOENT' ? 2 : 4)
        const success = (id, promise) => promise.then(() => stream.status(id,0), e => error(id,e))
        const attrs = stat => ({ mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs/1000), mtime: Math.floor(stat.mtimeMs/1000) })
        for (const type of ['STAT','LSTAT']) stream.on(type, (id,name) => fs.lstat(serverPath(name)).then(stat => stream.attrs(id,attrs(stat)), e => error(id,e)))
        stream.on('MKDIR',(id,name) => success(id,fs.mkdir(serverPath(name))))
        stream.on('REMOVE',(id,name) => success(id,fs.unlink(serverPath(name))))
        stream.on('RENAME',(id,from,to) => success(id,fs.link(serverPath(from),serverPath(to)).then(() => fs.unlink(serverPath(from)))))
        stream.on('OPEN',(id,name,flags) => fs.open(serverPath(name), flags & 2 ? 'w' : 'r').then(file => {
          const handle = Buffer.from(String(++handleId)); handles.set(handle.toString(),file); stream.handle(id,handle)
        }, e => error(id,e)))
        stream.on('FSTAT',(id,handle) => handles.get(handle.toString()).stat().then(stat => stream.attrs(id,attrs(stat)), e => error(id,e)))
        stream.on('READ',(id,handle,offset,length) => {
          const buffer=Buffer.alloc(length)
          handles.get(handle.toString()).read(buffer,0,length,offset).then(({ bytesRead }) => bytesRead ? stream.data(id,buffer.subarray(0,bytesRead)) : stream.status(id,1), e => error(id,e))
        })
        stream.on('WRITE',(id,handle,offset,data) => success(id,handles.get(handle.toString()).write(data,0,data.length,offset)))
        stream.on('CLOSE',(id,handle) => { const file=handles.get(handle.toString()); handles.delete(handle.toString()); success(id,file.close()) })
      })
    }))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const client = new ssh2.Client()
  try {
    await new Promise((resolve,reject) => client.once('ready',resolve).once('error',reject).connect({ host:'127.0.0.1', port:server.address().port, username:'test', password:'synthetic', readyTimeout:3000 }))
    const networkPool = { withSftp: fn => new Promise((resolve,reject) => client.sftp((error,sftp) => {
      if(error) return reject(error)
      fn(sftp).then(resolve,reject).finally(() => sftp.end())
    })) }
    const bytes=Buffer.alloc(150000); for(let i=0;i<bytes.length;i++) bytes[i]=i%256
    const source=path.join(temp,'network-source.bin'), target=path.join(temp,'network-target.bin')
    await fs.writeFile(source,bytes)
    await createTransferTool('upload',networkPool,'/work','test').execute({ localPath:source, remotePath:'/work/file.bin' },ctx())
    await createTransferTool('download',networkPool,'/work','test').execute({ localPath:target, remotePath:'/work/file.bin' },ctx())
    assert.deepEqual(await fs.readFile(target),bytes)
  } finally {
    client.destroy()
    for(const connection of clients) connection.end()
    for(const file of handles.values()) await file.close().catch(()=>{})
    await new Promise(resolve => server.close(resolve))
  }
})
