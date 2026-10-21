// `npm run setup` installs from source; `npm run unregister` removes only our loader.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const marker = '// Managed by opencode-remote-code setup.'
const pluginUrl = pathToFileURL(path.join(root, 'dist', 'index.js')).href
const loader = `${marker}\nimport plugin from ${JSON.stringify(pluginUrl)}\nexport default plugin.server\n`

function configDirectory() {
  return path.resolve(process.env.OPENCODE_CONFIG_DIR || path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode',
  ))
}

function checkPluginDestination(configDir) {
  const entry = path.join(configDir, 'plugins', 'remote-code.js')
  if (fs.existsSync(entry) && !fs.readFileSync(entry, 'utf8').startsWith(marker + '\n')) {
    throw new Error(`已有非本安装器管理的插件：${entry}。请先备份并移走该文件，再运行 setup。`)
  }
  return entry
}

function registerPlugin(configDir) {
  const entry = checkPluginDestination(configDir)
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, loader)
  return entry
}

function unregisterPlugin(configDir) {
  const entry = checkPluginDestination(configDir)
  if (!fs.existsSync(entry)) return
  if (fs.readFileSync(entry, 'utf8') !== loader) throw new Error('插件入口指向其他安装目录，请从对应源码目录运行 npm run unregister。')
  fs.unlinkSync(entry)
}

function runNpm(args, capture = false) {
  const cli = process.env.npm_execpath
  if (!cli) throw new Error('请运行 npm run setup。')
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 失败。请处理上方错误后重试；全局安装权限问题可参考 https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally 。`)
  return (result.stdout || '').trim()
}

async function main() {
  if (process.argv[2] === '--unregister') {
    unregisterPlugin(configDirectory())
    console.log('插件入口已移除。移除全局命令：npm uninstall -g opencode-remote-code')
    return
  }
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更新版本。')
  checkPluginDestination(configDirectory())
  console.log('[1/4] 安装依赖……')
  // OpenCode supplies its plugin API. Build with dev dependencies even under NODE_ENV=production.
  runNpm(['install', '--include=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'])
  const spawn = require('cross-spawn')
  const host = spawn.sync('opencode', ['--version'], { encoding: 'utf8', timeout: 10000 })
  if (host.error || host.status !== 0) throw new Error('请先安装 OpenCode CLI，并确认 opencode --version 可用，再重新运行 npm run setup。')
  console.log('[2/4] 构建插件……')
  runNpm(['run', 'build'])
  await import(pluginUrl)
  console.log('[3/4] 注册全局命令 opencode-remote……')
  runNpm(['link', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'])
  const entry = registerPlugin(configDirectory())
  console.log(`[4/4] 已注册插件：${entry}`)
  const command = spawn.sync('opencode-remote', ['--version'], { encoding: 'utf8', timeout: 10000 })
  const version = require('../package.json').version
  if (command.error || command.status !== 0 || command.stdout.trim() !== version) {
    const prefix = runNpm(['prefix', '-g'], true)
    const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin')
    console.log(`\n命令已注册，但尚未在 PATH 中找到正确版本。请把以下目录加入用户 PATH，然后重开终端：\n${binDir}`)
    if (process.platform === 'win32') console.log('Windows：设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → 用户 Path。')
    else console.log(`Bash/Zsh：在 ~/.bashrc 或 ~/.zshrc 中加入 export PATH=${"'" + binDir.replace(/'/g, "'\\''") + "'"}:"$PATH"`)
  }
  console.log(`
安装完成！

首次连接（任意目录）：  opencode-remote
修改连接配置：          opencode-remote config
查看当前配置：          opencode-remote config show
清除已记住密码：        opencode-remote config forget-password
排查连接问题：          opencode-remote doctor
完整操作说明：          opencode-remote --help

首次启动会引导填写 SSH、远程目录及认证方式；密码隐藏输入，可选记住。
请保留源码目录：${root}
更新或移动目录后：在该目录重新运行 npm run setup。
`)
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Remote Code setup: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { registerPlugin, unregisterPlugin, checkPluginDestination }
