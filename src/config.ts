import os from "os"
import path from "path"

export interface RemoteConfig {
  /** Raw SSH command string, e.g. "ssh -oHostKeyAlgorithms=+ssh-rsa root@host" */
  sshCommand: string
  /** Parsed SSH target host */
  host: string
  /** Parsed SSH user */
  user: string
  /** Parsed SSH port */
  port: number
  /** Parsed identity file (optional) */
  identity?: string
  /** Extra SSH -o options */
  extraOptions: string[]
  /** SSH login password (optional, handled by ssh2) */
  password?: string
  /** Sudo password for remote commands (optional) */
  sudoPassword?: string
  /** Remote working directory (absolute path on remote) */
  remoteWorkdir: string
  /** Local mirror root directory */
  mirrorRoot: string
  /** Whether remote mode is active */
  active: boolean
}

/** Tokenize a command as data; never execute it through a local shell. */
export function splitSshCommand(command: string): string[] {
  const tokens: string[] = []
  let token = ""
  let quote = ""
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === "\\" && quote !== "'" && (command[i + 1] === '"' || (!quote && command[i + 1] === "'") || (quote === '"' && command[i + 1] === "\\") || (!quote && /\s/.test(command[i + 1] || "")))) {
      token += command[++i]
    } else if (quote) {
      if (ch === quote) quote = ""
      else token += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (token) tokens.push(token)
      token = ""
    } else {
      token += ch
    }
  }
  if (quote) throw new Error("Remote Code: unclosed quote in REMOTE_SSH")
  if (token) tokens.push(token)
  return tokens
}

/** Saved key paths must remain valid when the launcher is run from another directory. */
export function normalizeSshCommand(command: string): string {
  const tokens = splitSshCommand(command)
  const parsed = parseSshCommand(command)
  const index = tokens.lastIndexOf("-i")
  if (index < 0 || tokens[index + 1] === parsed.identity) return command.trim()
  tokens[index + 1] = parsed.identity!
  return tokens.map(token => /[\s\\"']/.test(token) ? JSON.stringify(token) : token).join(" ")
}

export function parseSshCommand(cmd: string): {
  host: string
  user: string
  port: number
  identity?: string
  extraOptions: string[]
} {
  const tokens = splitSshCommand(cmd)
  if (tokens.length === 0 || tokens[0] !== "ssh") {
    throw new Error(`Remote Code: REMOTE_SSH must start with "ssh", got: ${cmd}`)
  }

  let host = ""
  let user = ""
  let port = 22
  let identity: string | undefined
  const extraOptions: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === "-p" || tok === "--port") {
      const value = tokens[++i]
      port = Number(value)
      if (!/^\d+$/.test(value || "") || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Remote Code: SSH port must be between 1 and 65535")
      }
    } else if (tok === "-i") {
      identity = tokens[++i]
      if (!identity || identity.startsWith("-")) throw new Error("Remote Code: -i requires a key path")
      if (identity.startsWith("~/")) identity = path.join(os.homedir(), identity.slice(2))
      identity = path.resolve(identity)
    } else if (tok === "-l") {
      user = tokens[++i]
      if (!user || user.startsWith("-")) throw new Error("Remote Code: -l requires a username")
    } else if (tok.startsWith("-o")) {
      // Handle both `-oKey=Value` and `-o Key=Value`
      if (tok === "-o") {
        const option = tokens[++i]
        if (!option || option.startsWith("-")) throw new Error("Remote Code: -o requires an option")
        extraOptions.push("-o", option)
      } else {
        extraOptions.push("-o", tok.slice(2))
      }
    } else if (tok.startsWith("-")) {
      // Other flags we don't explicitly parse; if they take args, skip next token heuristically
      // This is best-effort; users with exotic flags should rely on -o
      if (!["-v", "-vv", "-vvv", "-4", "-6", "-A", "-a", "-T", "-t", "-C", "-q"].includes(tok) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++
      }
    } else if (tok.includes("@")) {
      const at = tok.lastIndexOf("@")
      user = tok.slice(0, at)
      host = tok.slice(at + 1)
    } else {
      host = tok
    }
  }

  if (!host) {
    throw new Error(`Remote Code: could not parse host from REMOTE_SSH: ${cmd}`)
  }
  if (!user) {
    user = "root"
  }

  return { host, user, port, identity, extraOptions }
}

export function loadConfig(_options?: Record<string, unknown>): RemoteConfig | null {
  // OpenCode's CLI does not accept --remote flags. Launchers pass only environment variables.
  const sshCommand = process.env.REMOTE_SSH
  if (!sshCommand) return null
  const remoteWorkdir = process.env.REMOTE_WORKDIR
  if (!remoteWorkdir) throw new Error("Remote Code: REMOTE_WORKDIR is required")
  return {
    sshCommand,
    ...parseSshCommand(sshCommand),
    password: process.env.REMOTE_PASSWORD || undefined,
    sudoPassword: process.env.REMOTE_SUDO_PASSWORD || undefined,
    remoteWorkdir,
    mirrorRoot: process.env.REMOTE_MIRROR || path.join(os.homedir(), ".opencode", "mirrors"),
    active: true,
  }
}
