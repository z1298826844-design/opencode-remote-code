import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { parseSshCommand, normalizeSshCommand } from "../config.js"

export const settings = {
  ssh: { env: "REMOTE_SSH", fallback: "" },
  workdir: { env: "REMOTE_WORKDIR", fallback: "" },
  auth: { env: "REMOTE_AUTH", fallback: "password" },
  sudo: { env: "REMOTE_SUDO", fallback: false },
  mirror: { env: "REMOTE_MIRROR", fallback: "" },
  "pool-command-size": { env: "REMOTE_POOL_COMMAND_SIZE", fallback: 3 },
  "pool-file-size": { env: "REMOTE_POOL_FILE_SIZE", fallback: 2 },
  "pool-stagger-ms": { env: "REMOTE_POOL_STAGGER_MS", fallback: 0 },
} as const
export type Setting = keyof typeof settings
export type Values = Partial<Record<Setting, string | number | boolean>>
export type SecretKind = "ssh" | "sudo"
export interface Profile { id: string; name: string; values: Values }
export interface State {
  version: 2
  profiles: Profile[]
  selected?: string
  defaults: Values
  values: Values
  // The values are memory preferences, never passwords. Keep old targets so reset can delete them.
  credentials: Record<string, Partial<Record<SecretKind, boolean>>>
}
export const emptyState = (): State => {
  const state = { version: 2, profiles: [], defaults: {}, credentials: {} } as unknown as State
  // Active settings are a view; persist profiles only, without a second copy that can drift.
  Object.defineProperty(state, "values", {
    get() { return state.profiles.find(p => p.id === state.selected)?.values || state.defaults },
    set(values: Values) {
      const profile = state.profiles.find(p => p.id === state.selected)
      if (profile) profile.values = values
      else state.defaults = values
    },
  })
  return state
}
export const configRoot = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
export const configFile = () => path.join(configRoot(), "opencode-remote", "config.json")
export const pluginFile = () => path.join(process.env.OPENCODE_CONFIG_DIR || path.join(configRoot(), "opencode"), "plugins", "remote-code.js")

export function settingName(key: string): Setting {
  if (!Object.hasOwn(settings, key)) throw new Error(`未知配置项 ${key}。可用项：${Object.keys(settings).join(", ")}；密码请通过 opencode-remote config 修改。`)
  return key as Setting
}

export function validate(key: Setting, value: unknown): string | number | boolean {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`${key} 的值无效。`)
  const text = String(value).trim()
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`${key} 不能包含控制字符。`)
  if (key === "sudo") {
    if (text !== "true" && text !== "false") throw new Error("sudo 必须为 true 或 false。")
    return text === "true"
  }
  if (key.startsWith("pool-")) {
    const min = key === "pool-stagger-ms" ? 0 : 1
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min) throw new Error(`${key} 必须是 >= ${min} 的整数。`)
    return Number(text)
  }
  if (!text) throw new Error(`${key} 不能为空。`)
  if (key === "ssh") return normalizeSshCommand(text)
  if (key === "workdir" && !text.startsWith("/")) throw new Error("workdir 必须是远程绝对路径，例如 /home/project。")
  if (key === "auth" && !["password", "key"].includes(text)) throw new Error("auth 必须为 password 或 key。")
  if (key === "mirror") return path.resolve(text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text)
  return text
}

export function loadState(file = configFile()): State {
  if (!fs.existsSync(file)) return emptyState()
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    if (![1, 2].includes(data.version) || !data.credentials || typeof data.credentials !== "object" || Array.isArray(data.credentials)) throw new Error()
    const state = emptyState()
    const readValues = (input: unknown): Values => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error()
      const values: Values = {}
      for (const [key, value] of Object.entries(input)) values[settingName(key)] = validate(settingName(key), value)
      return values
    }
    if (data.version === 1) {
      const values = readValues(data.values)
      if (values.ssh) {
        const parsed = parseSshCommand(String(values.ssh))
        const id = randomUUID()
        state.profiles.push({ id, name: `${parsed.user}@${parsed.host}`, values })
        state.selected = id
      } else state.defaults = values
    } else {
      state.defaults = readValues(data.defaults)
      if (!Array.isArray(data.profiles)) throw new Error()
      for (const profile of data.profiles) {
        if (!profile || typeof profile.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(profile.id)
          || typeof profile.name !== "string" || !profile.name.trim() || /[\x00-\x1f\x7f]/.test(profile.name)
          || state.profiles.some(p => p.id === profile.id || p.name === profile.name)) throw new Error()
        state.profiles.push({ id: profile.id, name: profile.name, values: readValues(profile.values) })
      }
      if (data.selected !== undefined && !state.profiles.some(p => p.id === data.selected)) throw new Error()
      state.selected = data.selected
    }
    for (const [id, kinds] of Object.entries(data.credentials)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !kinds || typeof kinds !== "object" || Array.isArray(kinds)) throw new Error()
      const record: Partial<Record<SecretKind, boolean>> = {}
      for (const [kind, value] of Object.entries(kinds)) {
        if (!["ssh", "sudo"].includes(kind) || typeof value !== "boolean") throw new Error()
        record[kind as SecretKind] = value
      }
      state.credentials[id] = record
    }
    return state
  } catch {
    // JSON parser errors can contain source snippets; never echo file contents.
    throw new Error(`配置文件格式无效：${file}。请修正文件或先备份并移走，再运行 opencode-remote config。`)
  }
}

export function saveState(state: State, file = configFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function effective(state: Pick<State, "values">, env: NodeJS.ProcessEnv = process.env) {
  const values: Values = {}
  const sources: Partial<Record<Setting, string>> = {}
  for (const key of Object.keys(settings) as Setting[]) {
    const spec = settings[key]
    const fromEnv = env[spec.env]
    if (fromEnv !== undefined && fromEnv !== "") {
      values[key] = validate(key, fromEnv)
      sources[key] = spec.env
    } else if (state.values[key] !== undefined) {
      values[key] = state.values[key]
      sources[key] = "已保存"
    } else {
      values[key] = spec.fallback
      sources[key] = "默认值"
    }
  }
  if (sources.auth === "默认值" && values.ssh && parseSshCommand(String(values.ssh)).identity) values.auth = "key"
  if (env.REMOTE_SUDO_PASSWORD && !env.REMOTE_SUDO) {
    values.sudo = true
    sources.sudo = "REMOTE_SUDO_PASSWORD"
  }
  return { values, sources }
}

export function targetId(ssh: string): string {
  const { host, user, port } = parseSshCommand(ssh)
  return createHash("sha256").update(JSON.stringify([host.toLowerCase(), user, port])).digest("hex")
}

export function childEnvironment(values: Values, passwords: Partial<Record<SecretKind, string>>, base = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of Object.keys(settings) as Setting[]) {
    const value = values[key]
    if (value !== undefined && value !== "") env[settings[key].env] = String(value)
    else delete env[settings[key].env]
  }
  // Never inherit a disabled or unrelated credential into the OpenCode process.
  delete env.REMOTE_PASSWORD
  delete env.REMOTE_SUDO_PASSWORD
  if (values.auth === "password" && passwords.ssh) env.REMOTE_PASSWORD = passwords.ssh
  if (values.sudo && passwords.sudo) env.REMOTE_SUDO_PASSWORD = passwords.sudo
  return env
}

export function sessionDirectory(values: Values, home = os.homedir()): string {
  const { host } = parseSshCommand(String(values.ssh))
  // Preserve existing session directories for ordinary host/path combinations.
  const hostSlug = host.replace(/[^a-zA-Z0-9._-]/g, "_")
  const dirSlug = String(values.workdir).replace(/^\//, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/, "_")
  return path.join(home, ".opencode", "remote-sessions", `${hostSlug}_${dirSlug}`)
}
