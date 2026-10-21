import fs from "node:fs"
import { fileURLToPath } from "node:url"
import spawn from "cross-spawn"
import { Client } from "ssh2"
import { parseSshCommand, normalizeSshCommand } from "../config.js"
import { buildAlgorithms } from "../ssh-pool.js"
import { quoteShell } from "../shell-quote.js"
import { pluginFile, sessionDirectory, type Values } from "./settings.js"

export function checkInstallation(): string {
  const file = pluginFile()
  const pluginUrl = new URL("../index.js", import.meta.url).href
  if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes(JSON.stringify(pluginUrl))) {
    throw new Error(`插件未注册或指向其他安装目录：${file}。请在当前源码目录运行 npm run setup。`)
  }
  const result = spawn.sync("opencode", ["--version"], { encoding: "utf8", timeout: 10000 })
  if (result.error || result.status !== 0) throw new Error("无法运行 opencode。请先安装 OpenCode CLI，并确认 opencode --version 可用。")
  return result.stdout.trim()
}

export function checkAuthentication(values: Values, env = process.env) {
  const parsed = parseSshCommand(String(values.ssh))
  if (values.auth === "password" && parsed.identity) throw new Error("SSH 命令含 -i 密钥选项。请移除 -i，或运行 opencode-remote config set auth key。")
  if (values.auth === "key" && !parsed.identity && !env.SSH_AUTH_SOCK) throw new Error("密钥认证需要在 SSH 命令中用 -i 指定密钥，或设置 SSH_AUTH_SOCK 使用 SSH agent。请运行 opencode-remote config。")
  if (parsed.identity && !fs.existsSync(parsed.identity)) throw new Error(`密钥文件不存在：${parsed.identity}`)
}

export async function launch(values: Values, env: NodeJS.ProcessEnv, args: string[]) {
  // Resolve a relative key path before changing to the stable session directory.
  env.REMOTE_SSH = normalizeSshCommand(String(values.ssh))
  const directory = sessionDirectory(values)
  fs.mkdirSync(directory, { recursive: true })
  console.log(`会话目录：${directory}\n正在启动 OpenCode……`)
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("opencode", args, { env, cwd: directory, stdio: "inherit" })
    const interrupt = () => child.kill("SIGINT")
    const terminate = () => child.kill("SIGTERM")
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    const cleanup = () => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
    }
    child.once("error", error => { cleanup(); reject(error) })
    child.once("exit", (status, signal) => { cleanup(); resolve(status ?? (signal === "SIGINT" ? 130 : 143)) })
  })
  process.exitCode = code
}

/** One read-only SSH probe; do not initialize the pool's remote sudo askpass file. */
export async function checkRemote(values: Values, env: NodeJS.ProcessEnv) {
  const parsed = parseSshCommand(String(values.ssh))
  const privateKey = parsed.identity ? fs.readFileSync(parsed.identity) : undefined
  await new Promise<void>((resolve, reject) => {
    const client = new Client()
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error("SSH 检查超时。请检查网络、端口和 SSH 服务。")), 20000)
    client.once("error", () => finish(new Error("SSH 连接失败。请检查服务器、账号、密码/密钥和 SSH 算法配置。")))
    client.once("close", () => finish(new Error("SSH 连接提前关闭。")))
    client.once("ready", () => {
      const dir = quoteShell(String(values.workdir))
      client.exec(`test -d ${dir} && test -r ${dir} && test -x ${dir}`, (error, channel) => {
        if (error) return finish(new Error("无法检查远程目录。"))
        channel.resume()
        channel.stderr.resume()
        channel.once("error", () => finish(new Error("检查远程目录时连接中断。")))
        channel.once("close", (code: number) => finish(code === 0 ? undefined : new Error("远程目录不存在或不可访问。请运行 opencode-remote config 修改 workdir。")))
      })
    })
    try { client.connect({
      host: parsed.host, port: parsed.port, username: parsed.user,
      privateKey, password: env.REMOTE_PASSWORD,
      agent: !privateKey && !env.REMOTE_PASSWORD ? env.SSH_AUTH_SOCK : undefined,
      algorithms: buildAlgorithms(parsed.extraOptions), readyTimeout: 15000,
    }) } catch { finish(new Error("无法初始化 SSH 连接，请检查密钥格式和 SSH 参数；有口令的密钥请先载入 SSH agent。")) }
  })
}

export const packageFile = fileURLToPath(new URL("../../package.json", import.meta.url))
