import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isIP } from "node:net"
import { parseSshCommand, splitSshCommand } from "../config.js"
import type { Prompter } from "./prompt.js"
import type { Values } from "./settings.js"

/** Replace the wizard's fields while retaining existing advanced SSH options. */
function connectionCommand(previous: string, host: string, port: string, user: string, identity: string) {
  const original = previous ? splitSshCommand(previous).slice(1) : []
  const options: string[] = []
  for (let i = 0; i < original.length; i++) {
    const token = original[i]
    if (["-p", "--port", "-l", "-i"].includes(token)) { i++; continue }
    if (!token.startsWith("-")) continue // The new destination is appended below.
    options.push(token)
    // Match the parser's option arity so option values are never mistaken for destinations.
    if (token === "-o" || (!token.startsWith("-o") && !["-v", "-vv", "-vvv", "-4", "-6", "-A", "-a", "-T", "-t", "-C", "-q"].includes(token)
      && original[i + 1] && !original[i + 1].startsWith("-"))) options.push(original[++i])
  }
  const tokens = ["ssh", ...options, "-p", port, ...(identity ? ["-i", identity] : []), `${user}@${host}`]
  return tokens.map(token => /[\s\\"']/.test(token) ? JSON.stringify(token) : token).join(" ")
}

export async function configureConnection(
  prompt: Prompter,
  print: (message: string) => void,
  defaults: Values,
  env: NodeJS.ProcessEnv,
): Promise<{ ssh: string; auth: "password" | "key" }> {
  const previous = String(defaults.ssh || "")
  const saved = previous ? parseSshCommand(previous) : undefined
  async function field(label: string, fallback: string, example: string, validate: (input: string) => string) {
    while (true) {
      const input = (await prompt.text(`${label}${fallback ? "" : "（必填）"}`, fallback)).trim()
      if (!input) { print(`还没有填写${label}。例如 ${example}，输入后按回车。`); continue }
      try { return validate(input) }
      catch (error) { print(`${label}填写有误：${(error as Error).message}`) }
    }
  }

  print("\n[1/4] 连接哪台远程机器？")
  print("依次填写服务器地址、端口和登录账号。例如：192.168.1.10、22、alice。")
  const host = await field("服务器 IP / 主机名", saved?.host || "", "192.168.1.10 或 server.example.com", input => {
    const value = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input
    if (!isIP(value) && !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(value)) {
      throw new Error("请只填写 IP 或主机名，例如 192.168.1.10；账号在后面单独填写。")
    }
    return value
  })
  const port = await field("SSH 端口", String(saved?.port || 22), "22", input => {
    if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > 65535) throw new Error("请输入 1 到 65535 之间的整数，常用端口为 22。")
    return String(Number(input))
  })
  const user = await field("登录账号", saved?.user || "", "alice 或 root", input => {
    if (input.startsWith("-") || /[\s\x00-\x1f\x7f@/"'`;|&<>()[\]{}]/.test(input)) throw new Error("请只填写远程登录账号，例如 alice 或 root。")
    return input
  })

  print("\n[2/4] 如何登录？")
  const defaultAuth = defaults.auth === "key" ? "2" : "1"
  print(`  1. 密码登录${defaultAuth === "1" ? "（默认）" : ""}\n  2. SSH 密钥${defaultAuth === "2" ? "（默认）" : ""}`)
  let auth: "password" | "key"
  while (true) {
    const answer = (await prompt.text("认证方式（1=密码，2=密钥）", defaultAuth)).trim().toLowerCase()
    if (["1", "password", "2", "key"].includes(answer)) {
      auth = ["2", "key"].includes(answer) ? "key" : "password"
      break
    }
    print("请输入 1（密码登录）或 2（SSH 密钥），然后按回车。")
  }

  let identity = ""
  if (auth === "key") {
    print("填写本机的私钥文件路径，例如 ~/.ssh/id_ed25519；不要选择 .pub 公钥文件。")
    print("使用已加载密钥的 SSH agent 时输入 agent（适用于有口令的密钥）。")
    const detected = ["id_ed25519", "id_rsa"].find(name => fs.existsSync(path.join(os.homedir(), ".ssh", name)))
    const fallback = saved?.identity || (env.SSH_AUTH_SOCK ? "agent" : detected ? `~/.ssh/${detected}` : "")
    identity = await field("私钥文件路径（或 agent）", fallback, "~/.ssh/id_ed25519", input => {
      if (input.toLowerCase() === "agent") {
        if (!env.SSH_AUTH_SOCK) throw new Error("当前终端没有 SSH agent。请填写私钥路径，或先启动 agent 并加载密钥后重新配置。")
        return ""
      }
      const filename = path.resolve(input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input)
      if (filename.endsWith(".pub")) throw new Error("这是公钥文件；请选择同名且不带 .pub 的私钥。")
      try {
        if (!fs.statSync(filename).isFile()) throw new Error()
        fs.accessSync(filename, fs.constants.R_OK)
      } catch { throw new Error("找不到可读取的私钥文件，请检查本机路径。") }
      return filename
    })
  }
  return { ssh: connectionCommand(previous, host, port, user, identity), auth }
}
