import os from "node:os"
import path from "node:path"
import spawn from "cross-spawn"

export const isWsl = () => process.platform === "linux" && /microsoft/i.test(os.release())
export const localPlatform = () => process.platform === "win32" ? "Windows" : isWsl() ? "WSL (Windows CLI via powershell.exe)" : process.platform

export function runLocal(command: string, args: string[], options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<string> {
  const timeout = options.timeout ?? 120_000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) throw new Error("timeout must be between 1 and 600000 ms")
  options.signal?.throwIfAborted()
  const env = { ...process.env }
  // Local programs must not receive this SSH session's credentials.
  for (const key of Object.keys(env)) if (key.startsWith("REMOTE_")) delete env[key]
  return new Promise((resolve, reject) => {
    let output = "", bytesWritten = 0, truncated = false, failure: Error | undefined
    const child = spawn(command, args, { cwd: options.cwd || os.homedir(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const stop = (error: Error) => { failure = error; child.kill(); }
    const timer = setTimeout(() => stop(new Error("Local command timed out")), timeout)
    const abort = () => stop(new Error("Local command cancelled"))
    options.signal?.addEventListener("abort", abort, { once: true })
    const append = (text: string) => {
      const bytes = Buffer.from(text, "utf8")
      const remaining = 65536 - bytesWritten
      output += bytes.subarray(0, Math.max(0, remaining)).toString("utf8")
      bytesWritten += Math.min(bytes.length, remaining)
      if (bytes.length > remaining) truncated = true
    }
    child.stdout?.setEncoding("utf8").on("data", append)
    child.stderr?.setEncoding("utf8").on("data", append)
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort) }
    child.once("error", error => { cleanup(); reject(new Error(`Cannot execute local program ${command}: ${error.message}`)) })
    child.once("close", code => {
      cleanup()
      const result = output + (truncated ? "\n[output truncated at 64 KiB]" : "")
      if (failure) reject(new Error(`${failure.message}\n${result}`))
      else if (code !== 0) reject(new Error(`Local command exited with code ${code}\n${result}`))
      else resolve(result || "(no output)")
    })
  })
}

/** Resolve paths through WSL itself, respecting custom automount roots. */
export async function localPath(value: string): Promise<string> {
  if (!value || /[\x00-\x1f]/.test(value)) throw new Error("Provide an absolute local file path")
  if (process.platform !== "win32" && (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\"))) {
    if (!isWsl()) throw new Error("Windows paths require Windows or WSL")
    return (await runLocal("wslpath", ["-u", value])).trim()
  }
  if (!path.isAbsolute(value)) throw new Error("Local paths must be absolute (Windows drive paths are accepted in WSL)")
  return path.normalize(value)
}

export async function windowsPath(value: string): Promise<string> {
  if (path.win32.isAbsolute(value) && !value.startsWith("/")) return value
  if (isWsl() && path.posix.isAbsolute(value)) return (await runLocal("wslpath", ["-w", value])).trim()
  throw new Error("Provide an absolute Windows path or a WSL absolute path")
}

export function powershellScript(payload: object, body: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; try { $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; ${body} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
  return Buffer.from(script, "utf16le").toString("base64")
}

export async function runWindows(payload: { name?: string; args?: string[]; command?: string; cwd?: string }, options: { timeout?: number; signal?: AbortSignal } = {}) {
  if (process.platform !== "win32" && !isWsl()) throw new Error("Windows execution is available only on Windows or WSL; no remote fallback")
  const cwd = payload.cwd ? await windowsPath(payload.cwd) : undefined
  const body = `if ($p.cwd) { Set-Location -LiteralPath $p.cwd } else { Set-Location -LiteralPath $env:USERPROFILE }; $global:LASTEXITCODE=0; ` + (payload.name
    ? `$exe=Get-Command -Name $p.name -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1; $arguments=@($p.args | ForEach-Object { [string]$_ }); & $exe.Source @arguments; `
    : `& ([ScriptBlock]::Create($p.command)); `) + `$ok=$?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (!$ok) { exit 1 }`
  return runLocal("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", powershellScript({ ...payload, cwd }, body)], options)
}
