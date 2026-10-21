import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import type { ReadStream, WriteStream } from "node:tty"

export interface Prompter {
  text(label: string, defaultValue?: string, secret?: boolean): Promise<string>
  confirm(label: string, defaultValue?: boolean): Promise<boolean>
}

export class TerminalPrompt implements Prompter {
  constructor(
    private readonly input: ReadStream = process.stdin,
    private readonly output: WriteStream = process.stderr,
  ) {}

  async text(label: string, defaultValue = "", secret = false): Promise<string> {
    if (!this.input.isTTY || !this.output.isTTY) throw new Error("需要交互输入。请在终端运行 opencode-remote config，或设置所需 REMOTE_* 环境变量后重试。")
    const terminal = this.output
    let muted = false
    let answered = false
    const hiddenOutput = new Writable({ write(chunk, _encoding, callback) {
      if (!muted) terminal.write(chunk)
      callback()
    } })
    // readline needs the actual terminal width for wrapped prompts and cursor positioning.
    Object.defineProperty(hiddenOutput, "columns", { get: () => terminal.columns })
    const resize = () => hiddenOutput.emit("resize")
    if (secret) terminal.on("resize", resize)
    const rl = createInterface({ input: this.input, output: secret ? hiddenOutput : terminal, terminal: true, historySize: 0 })
    const question = `${label}${defaultValue && !secret ? ` [回车使用：${defaultValue}]` : ""}： `
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.once("SIGINT", () => rl.close())
        rl.once("close", () => reject(Object.assign(new Error("已取消。"), { code: "CANCELLED" })))
        // Let readline render its own prompt. Printing it separately would be erased by redraw.
        rl.question(question, answer => {
          answered = true
          resolve(answer || defaultValue)
        })
        // The initial prompt must be visible; only subsequent password echo is suppressed.
        muted = secret
      })
    } finally {
      rl.close()
      terminal.off("resize", resize)
      if (secret || !answered) terminal.write("\n")
      hiddenOutput.destroy()
    }
  }

  async confirm(label: string, defaultValue = false): Promise<boolean> {
    while (true) {
      const answer = (await this.text(`${label}（y=是，n=否，回车默认${defaultValue ? "是" : "否"}）`)).trim().toLowerCase()
      if (!answer) return defaultValue
      if (["y", "yes"].includes(answer)) return true
      if (["n", "no"].includes(answer)) return false
      console.log("请输入 y 或 n。")
    }
  }
}
