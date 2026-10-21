import { createRequire } from "node:module"
import type { State, SecretKind } from "./settings.js"

export interface CredentialStore {
  get(id: string, kind: SecretKind): Promise<string | null>
  set(id: string, kind: SecretKind, value: string): Promise<void>
  remove(id: string, kind: SecretKind): Promise<void>
}

export class SystemCredentials implements CredentialStore {
  private entry(id: string, kind: SecretKind) {
    // Optional native module: missing platform support must not prevent ordinary login.
    try {
      const { AsyncEntry } = createRequire(import.meta.url)("@napi-rs/keyring")
      return new AsyncEntry("opencode-remote", `${id}:${kind}`, { linux: { store: "secret-service" } })
    } catch {
      // No operation was attempted, so a new failed save does not need a deletion index.
      throw Object.assign(new Error("系统凭据服务不可用。"), { code: "CREDENTIAL_SERVICE_UNAVAILABLE" })
    }
  }
  async get(id: string, kind: SecretKind): Promise<string | null> {
    return this.entry(id, kind).getPassword(AbortSignal.timeout(10000))
  }
  async set(id: string, kind: SecretKind, value: string) {
    await this.entry(id, kind).setPassword(value, AbortSignal.timeout(10000))
  }
  async remove(id: string, kind: SecretKind) {
    await this.entry(id, kind).deletePassword(AbortSignal.timeout(10000))
  }
}

export const credentialWarning = "系统凭据服务不可用或已锁定，密码未能记住/读取。本次可继续输入密码连接；不会写入明文配置。Linux 需要已解锁的 Secret Service（如 GNOME Keyring/KWallet）。"

export async function forgetPasswords(state: State, store: CredentialStore, persist: () => void) {
  let failed = false
  for (const [id, kinds] of Object.entries(state.credentials)) {
    for (const kind of ["ssh", "sudo"] as const) {
      if (kinds[kind]) {
        try { await store.remove(id, kind) }
        catch { failed = true; continue }
      }
      delete kinds[kind]
    }
    if (!Object.keys(kinds).length) delete state.credentials[id]
    persist()
  }
  if (failed) throw new Error("部分密码未能删除，已保留凭据索引。请解锁系统凭据服务后重试 opencode-remote config forget-password。")
}
