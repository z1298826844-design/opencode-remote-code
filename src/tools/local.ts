import fs from "node:fs/promises"
import os from "node:os"
import { tool } from "@opencode-ai/plugin"
import { loadLocalSettings } from "../local-settings.js"
import { localPath, localPlatform, runLocal, runWindows } from "../local-runtime.js"

export function createLocalTools(settingsFile?: string) {
  return {
    local_cli: tool({
      description: "Execute a configured Windows CLI by name through Windows PATH, including when OpenCode runs in WSL. Supply arguments as an array; no shell operators. Consult skills/MCP/help for CLI usage. Never executes on the remote server.",
      args: { name: tool.schema.string(), args: tool.schema.array(tool.schema.string()), workdir: tool.schema.string().optional(), timeout: tool.schema.number().optional() },
      async execute(args, ctx) {
        const names = loadLocalSettings(settingsFile).windowsCli
        if (!names.includes(args.name.toLowerCase())) throw new Error("CLI is not in global windowsCli. Configure it with opencode-remote config windows-cli")
        await ctx.ask({ permission: "local_execute", patterns: [args.name], always: [args.name], metadata: { location: "Windows", ...args } })
        const output = await runWindows({ name: args.name, args: args.args, cwd: args.workdir }, { timeout: args.timeout, signal: ctx.abort })
        return { title: `Windows: ${args.name}`, output: `Execution location: local Windows / PowerShell\nWorking directory: ${args.workdir || "Windows user profile"}\n${output}`, metadata: { location: "local-windows" } }
      },
    }),
    local_bash: tool({
      description: "Execute an explicitly local command. environment=windows uses Windows PowerShell; environment=host uses /bin/bash on Linux/WSL/macOS (PowerShell on native Windows). Ordinary project commands belong to remote bash. Use local_cli for registered Windows CLIs.",
      args: { command: tool.schema.string(), environment: tool.schema.enum(["host", "windows"]), workdir: tool.schema.string().optional(), timeout: tool.schema.number().optional() },
      async execute(args, ctx) {
        await ctx.ask({ permission: "local_execute", patterns: [args.command], always: [], metadata: { location: args.environment, ...args } })
        const windows = args.environment === "windows" || process.platform === "win32"
        const output = windows
          ? await runWindows({ command: args.command, cwd: args.workdir }, { timeout: args.timeout, signal: ctx.abort })
          : await runLocal("/bin/bash", ["-c", args.command], { cwd: args.workdir ? await localPath(args.workdir) : os.homedir(), timeout: args.timeout, signal: ctx.abort })
        return { title: `Local ${args.environment}`, output: `Execution location: local ${windows ? "Windows / PowerShell" : localPlatform()}\nWorking directory: ${args.workdir || (windows ? "Windows user profile" : os.homedir())}\n${output}`, metadata: { location: "local" } }
      },
    }),
    local_read: tool({
      description: "Read a LOCAL UTF-8 text file or list a LOCAL directory. Windows absolute paths work on Windows and WSL. Does not read remote files. Binary/PDF/Office files require an appropriate local parser or skill first.",
      args: { path: tool.schema.string(), offset: tool.schema.number().int().min(1).optional(), limit: tool.schema.number().int().min(1).max(2000).optional() },
      async execute(args, ctx) {
        const filename = await localPath(args.path)
        await ctx.ask({ permission: "local_read", patterns: [filename], always: [filename], metadata: { location: "local", path: filename } })
        ctx.abort.throwIfAborted()
        const stat = await fs.stat(filename)
        if (stat.isDirectory()) {
          const entries = await fs.readdir(filename, { withFileTypes: true })
          return `Location: local ${localPlatform()}\nPath: ${filename}\n${entries.slice(0, 2000).map(e => e.name + (e.isDirectory() ? "/" : "")).join("\n")}${entries.length > 2000 ? "\n[directory listing truncated]" : ""}`
        }
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("local_read supports regular text files up to 10 MiB; use a local parser for larger files")
        const content = await fs.readFile(filename)
        if (content.includes(0) || content.subarray(0, 5).toString() === "%PDF-" || content.subarray(0, 2).toString() === "PK") throw new Error("Binary/document file: use a local parser to extract text first")
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content)
        const lines = text.split("\n"), start = (args.offset ?? 1) - 1
        const selected = lines.slice(start, start + (args.limit ?? 200)).map((line, i) => `${start + i + 1}: ${line.slice(0, 2000)}`)
        return `Location: local ${localPlatform()}\nPath: ${filename}\nTotal lines: ${lines.length}\n${selected.join("\n").slice(0, 65536)}\n[Use offset/limit for more lines; long lines/output are truncated.]`
      },
    }),
  }
}
