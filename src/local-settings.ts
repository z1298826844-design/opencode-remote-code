import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { configRoot } from "./cli/settings.js"

export interface LocalSettings { version: 1; windowsCli: string[] }
export const localSettingsFile = () => path.join(configRoot(), "opencode-remote", "global.json")

export function validateWindowsCli(input: unknown): string[] {
  if (!Array.isArray(input) || input.some(name => typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))) {
    throw new Error("Windows CLI 只填写命令名，例如 docfetch、internal-cli；不要填写路径或参数。")
  }
  return [...new Set(input.map(name => name.toLowerCase()))]
}
export function loadLocalSettings(file = localSettingsFile()): LocalSettings {
  if (!fs.existsSync(file)) return { version: 1, windowsCli: [] }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"))
    if (value.version !== 1) throw new Error()
    return { version: 1, windowsCli: validateWindowsCli(value.windowsCli) }
  } catch { throw new Error(`本机全局配置格式无效：${file}。请检查 windowsCli 命令名列表。`) }
}
export function saveLocalSettings(windowsCli: string[], file = localSettingsFile()) {
  const value: LocalSettings = { version: 1, windowsCli: validateWindowsCli(windowsCli) }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    fs.renameSync(temp, file)
  } finally { fs.rmSync(temp, { force: true }) }
}
