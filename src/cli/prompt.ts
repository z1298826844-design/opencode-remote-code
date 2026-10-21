import { createInterface } from "node:readline"
import { Writable } from "node:stream"

export interface Prompter {
  text(label: string, defaultValue?: string, secret?: boolean): Promise<string>
  confirm(label: string, defaultValue?: boolean): Promise<boolean>
}

export class TerminalPrompt implements Prompter {
  async text(label: string, defaultValue = "", secret = false): Promise<string> {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("需要交互输入。请在终端运行 opencode-remote config，或设置所需 REMOTE_* 环境变量后重试。")
    process.stderr.write(`${label}${defaultValue && !secret ? ` [${defaultValue}]` : ""}：`)
    const output = new Writable({ write(chunk, _encoding, callback) {
      if (!secret) process.stderr.write(chunk)
      callback()
    } })
    const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 })
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.once("SIGINT", () => rl.close())
        rl.once("close", () => reject(Object.assign(new Error("已取消。"), { code: "CANCELLED" })))
        rl.question("", answer => resolve(answer || defaultValue))
      })
    } finally {
      rl.close()
      if (secret) process.stderr.write("\n")
    }
  }

  async confirm(label: string, defaultValue = false): Promise<boolean> {
    while (true) {
      const answer = (await this.text(`${label} ${defaultValue ? "[Y/n]" : "[y/N]"}`)).trim().toLowerCase()
      if (!answer) return defaultValue
      if (["y", "yes"].includes(answer)) return true
      if (["n", "no"].includes(answer)) return false
      console.log("请输入 y 或 n。")
    }
  }
}
