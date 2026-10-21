import fs from "node:fs"
import { parseSshCommand } from "../config.js"
import { TerminalPrompt, type Prompter } from "./prompt.js"
import { SystemCredentials, credentialWarning, forgetPasswords, type CredentialStore } from "./credentials.js"
import { configFile, loadState, saveState, effective, settings, settingName, validate, targetId, childEnvironment, type State, type Setting, type SecretKind } from "./settings.js"
import { checkInstallation, checkAuthentication, checkRemote, launch, packageFile } from "./runtime.js"
import { configureConnection } from "./connection.js"

const help = `OpenCode Remote — 在任意目录连接远程工作区

用法：
  opencode-remote                       连接；首次使用会引导配置
  opencode-remote config                交互修改连接与密码记忆设置
  opencode-remote config show           查看配置及来源（不显示密码）
  opencode-remote config set <项> <值>  修改单项配置
  opencode-remote config unset <项>     删除某项保存值
  opencode-remote config forget-password  清除所有目标的已记住密码
  opencode-remote config reset          确认后清空配置和密码，保留会话
  opencode-remote doctor                检查安装、SSH 连接和远程目录
  opencode-remote -- --continue         将 -- 后的参数传给 OpenCode
  opencode-remote --help | --version

示例：
  opencode-remote config                按提示填写 IP、端口（默认 22）、账号和密码/密钥
  opencode-remote config set workdir /home/project
  opencode-remote config set sudo true

高级连接设置：
  opencode-remote config set ssh "ssh -p 2222 user@host"

配置项：ssh, workdir, auth (password/key), sudo (true/false), mirror,
        pool-command-size (默认 3), pool-file-size (默认 2), pool-stagger-ms (默认 0)
优先级：REMOTE_* 环境变量 > 保存的配置 > 默认值。
密钥认证：在配置向导填写私钥路径，或输入 agent 使用本机 SSH agent。
SSH 与 sudo 密码分别询问，可选择记入系统凭据库；不会保存到配置文件。
更新：源码目录运行 git pull，再运行 npm run setup。
卸载：先 config reset（可选），再在源码目录 npm run unregister，
      最后 npm uninstall -g opencode-remote-code。
`

export class RemoteCLI {
  state: State
  private passwords = new Map<string, Partial<Record<SecretKind, string>>>()
  constructor(
    readonly file = configFile(),
    readonly prompt: Prompter = new TerminalPrompt(),
    readonly store: CredentialStore = new SystemCredentials(),
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly print: (message: string) => void = console.log,
  ) { this.state = loadState(file) }

  persist = () => saveState(this.state, this.file)

  private async field(key: Setting, label: string, defaultValue = "") {
    while (true) {
      const input = await this.prompt.text(`${label}${defaultValue ? "" : "（必填）"}`, defaultValue)
      if (!input.trim()) {
        const example = key === "ssh" ? "ssh alice@192.168.1.10" : "/home/alice/project"
        this.print(`还没有填写${label}。请输入具体内容，例如 ${example}，再按回车。`)
        continue
      }
      try { return validate(key, input) }
      catch (error) { this.print(`${label}填写有误：${(error as Error).message}`) }
    }
  }

  private async readStored(id: string, kind: SecretKind): Promise<string | undefined> {
    if (!this.state.credentials[id]?.[kind]) return undefined
    try { return (await this.store.get(id, kind)) || undefined }
    catch { this.print(credentialWarning); return undefined }
  }

  private async remember(id: string, kind: SecretKind, password: string, yes: boolean) {
    const record = this.state.credentials[id] ||= {}
    const wasRemembered = record[kind] === true
    if (!yes && record[kind]) {
      try { await this.store.remove(id, kind) }
      catch { throw new Error("无法清除原密码，尚未取消记忆。请解锁系统凭据库后运行 opencode-remote config forget-password。") }
    }
    record[kind] = yes
    // Record the target before writing a secret, so a later failure cannot orphan it.
    this.persist()
    if (yes) {
      try { await this.store.set(id, kind, password) }
      catch (error) {
        if ((error as { code?: string }).code === "CREDENTIAL_SERVICE_UNAVAILABLE" && !wasRemembered) {
          record[kind] = false
          this.persist()
        }
        this.print(credentialWarning)
      }
    }
  }

  async password(id: string, kind: SecretKind, configure = false): Promise<string> {
    const variable = kind === "ssh" ? "REMOTE_PASSWORD" : "REMOTE_SUDO_PASSWORD"
    const label = kind === "ssh" ? "SSH 登录密码" : "sudo 密码"
    if (!configure && this.env[variable]) return this.env[variable]!
    const current = this.passwords.get(id)?.[kind]
    if (!configure && current) return current
    const stored = await this.readStored(id, kind)
    if (!configure && stored) return stored
    this.print(`\n${label}：输入时不会显示字符或星号，输入完成后按回车提交。`)
    if (stored) this.print("已有记住的密码；直接回车可保留，输入新密码可替换。")
    let password = ""
    while (!password) {
      password = await this.prompt.text(label, "", true)
      if (!password && stored) password = stored
      if (!password) this.print("密码不能为空，请重新输入。若需改用密钥，可按 Ctrl+C 后运行 opencode-remote config。")
    }
    const preference = this.state.credentials[id]?.[kind]
    const remember = configure || preference === undefined
      ? await this.prompt.confirm(`是否记住${label}`, preference === true)
      : preference
    await this.remember(id, kind, password, remember)
    this.passwords.set(id, { ...this.passwords.get(id), [kind]: password })
    return password
  }

  async configure() {
    this.print("\nOpenCode Remote · 连接配置")
    this.print("按下面 4 个步骤填写。有默认值时可直接回车使用；按 Ctrl+C 随时取消。")
    const defaults = effective(this.state, this.env).values
    const connection = await configureConnection(this.prompt, this.print, defaults, this.env)
    const values = { ...this.state.values, ...connection }
    checkAuthentication(values, this.env)
    const id = targetId(connection.ssh)
    if (connection.auth === "password") await this.password(id, "ssh", true)
    this.print("\n[3/4] 要操作远程机器上的哪个目录？")
    this.print("填写远程项目的绝对路径，必须以 / 开头，例如 /home/alice/project。")
    values.workdir = await this.field("workdir", "远程工作目录", String(defaults.workdir || ""))
    this.print("\n[4/4] 是否需要为 sudo 命令提供密码？")
    this.print("普通登录请选择“否”（n）；需要执行带密码的 sudo 命令时选“是”（y）。")
    values.sudo = await this.prompt.confirm("需要 sudo 密码吗", defaults.sudo === true)
    if (values.sudo) await this.password(id, "sudo", true)
    this.state.values = values
    this.persist()
    const parsed = parseSshCommand(connection.ssh)
    this.print([
      `\n连接配置已保存：${this.file}`,
      `  服务器：${parsed.host}`,
      `  端口：${parsed.port}`,
      `  账号：${parsed.user}`,
      `  工作目录：${values.workdir}`,
      `  登录方式：${connection.auth === "key" ? "SSH 密钥" : "SSH 密码"}`,
      ...(connection.auth === "key" ? [`  密钥来源：${parsed.identity || "SSH agent"}`] : []),
      `  sudo 密码：${values.sudo ? "需要" : "不需要"}`,
      "\n启动：opencode-remote\n修改配置：opencode-remote config\n查看配置：opencode-remote config show",
    ].join("\n"))
    const overrides = Object.values(settings).filter(spec => this.env[spec.env]).map(spec => spec.env)
    if (overrides.length) this.print(`当前环境变量优先于已保存配置：${overrides.join(", ")}`)
  }

  show() {
    const { values, sources } = effective(this.state, this.env)
    this.print(`配置文件：${this.file}`)
    for (const key of Object.keys(settings) as Setting[]) this.print(`${key}: ${values[key] === "" ? "(未设置)" : values[key]}  [${sources[key]}]`)
    const record = values.ssh ? this.state.credentials[targetId(String(values.ssh))] : undefined
    for (const kind of ["ssh", "sudo"] as const) {
      const variable = kind === "ssh" ? "REMOTE_PASSWORD" : "REMOTE_SUDO_PASSWORD"
      this.print(`${variable}: ${this.env[variable] ? "已设置（环境变量，隐藏）" : record?.[kind] ? "已登记系统凭据（可用性在连接时检查）" : "未记住"}`)
    }
  }

  async configCommand(args: string[]) {
    if (!args.length) return this.configure()
    const [command, key, value] = args
    if (command === "show" && args.length === 1) return this.show()
    if ((command === "set" && args.length === 3) || (command === "unset" && args.length === 2)) {
      const name = settingName(key)
      if (command === "set") this.state.values[name] = validate(name, value)
      else delete this.state.values[name]
      this.persist()
      this.print(`已${command === "set" ? "更新" : "删除"} ${name}。运行 opencode-remote 连接。`)
      if (this.env[settings[name].env]) this.print(`注意：当前 ${settings[name].env} 环境变量仍优先。`)
      return
    }
    if (command === "forget-password" && args.length === 1) {
      await forgetPasswords(this.state, this.store, this.persist)
      this.passwords.clear()
      this.print("已清除所有登记目标的已记住密码。环境变量中的密码不受影响。")
      return
    }
    if (command === "reset" && args.length === 1) {
      if (!await this.prompt.confirm("清空连接配置及所有已记住密码？会话历史将保留")) return
      await forgetPasswords(this.state, this.store, this.persist)
      fs.rmSync(this.file, { force: true })
      this.passwords.clear()
      this.print("配置与密码已清空。运行 opencode-remote 重新配置。")
      return
    }
    throw new Error("配置命令格式不正确。请运行 opencode-remote --help。")
  }

  async connection(doctor = false) {
    let values = effective(this.state, this.env).values
    if (!values.ssh || !values.workdir) {
      if (doctor) throw new Error("缺少连接配置。请运行 opencode-remote config。")
      await this.configure()
      values = effective(this.state, this.env).values
    }
    checkAuthentication(values, this.env)
    this.print(`远程连接：${values.ssh}\n工作目录：${values.workdir}`)
    const id = targetId(String(values.ssh))
    const passwords: Partial<Record<SecretKind, string>> = {}
    if (values.auth === "password") passwords.ssh = await this.password(id, "ssh")
    if (values.sudo && !doctor) passwords.sudo = await this.password(id, "sudo")
    return { values, env: childEnvironment(values, passwords, this.env) }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--help" || (args[0] === "config" && args[1] === "--help")) { console.log(help); return }
  if (args[0] === "--version") { console.log(JSON.parse(fs.readFileSync(packageFile, "utf8")).version); return }
  const cli = new RemoteCLI()
  if (args[0] === "config") { await cli.configCommand(args.slice(1)); return }
  const doctor = args[0] === "doctor" && args.length === 1
  if (args.length && args[0] !== "--" && !doctor) throw new Error("未知命令。请运行 opencode-remote --help；OpenCode 参数放在 -- 后。")
  const version = checkInstallation()
  if (doctor) console.log(`✓ OpenCode ${version}\n✓ 插件已注册\n✓ Node.js ${process.versions.node}`)
  const { values, env } = await cli.connection(doctor)
  if (doctor) {
    await checkRemote(values, env)
    console.log("✓ SSH 认证成功\n✓ 远程目录存在且可访问\n现在可以运行 opencode-remote。")
  } else {
    await launch(values, env, args[0] === "--" ? args.slice(1) : [])
  }
}
