import type { SSHPool } from "./ssh-pool.js"
import { quoteShell } from "./shell-quote.js"
import { getProviderPrompt } from "./prompts/index.js"

export interface RemoteSystemPromptContext {
  remoteHost?: string
  localPlatform?: string
  localHome?: string
  windowsCli?: string[]
  modelID: string
  remoteWorkdir: string
  remotePlatform: string
  isGitRepo: boolean
  sshPool: SSHPool
}

export async function buildRemoteSystemPrompt(
  ctx: RemoteSystemPromptContext,
  originalSystem: string[]
): Promise<string[]> {
  // 1. Determine provider prompt based on model
  const providerPrompt = getProviderPrompt(ctx.modelID)

  // 2. Build remote environment block
  const envBlock = [
    `You are powered by the model named ${ctx.modelID}.`,
    `Here is some useful information about the environment you are running in:`,
    `<env>`,
    `  Working directory: ${ctx.remoteWorkdir}`,
    `  Workspace root folder: ${ctx.remoteWorkdir}`,
    `  Is directory a git repo: ${ctx.isGitRepo ? "yes" : "no"}`,
    `  Platform: ${ctx.remotePlatform}`,
    `  Today's date: ${new Date().toDateString()}`,
    `</env>`,
  ].join("\n")

  const routing = [
    "<local_remote_tools>",
    `Primary workspace is REMOTE: ${ctx.remoteHost || "SSH server"}:${ctx.remoteWorkdir}.`,
    "bash, glob, grep, read, write, edit, apply_patch operate on the remote server. Use them by default for project commands and code changes.",
    `Local host: ${ctx.localPlatform || "unknown"}; local home: ${ctx.localHome || "unknown"}. Local and remote paths/files are separate.`,
    `Windows CLI names (global, shared across server connections): ${JSON.stringify(ctx.windowsCli || [])}.`,
    "When executing a CLI in this list, use local_cli(name, args) on WINDOWS, never remote bash. If missing from Windows PATH, report it; do not fall back to remote execution. The list describes location only, not CLI usage or an execution sandbox.",
    "Use existing skills, MCP tools, and CLI help for usage. MCP tool calls are independent and are not redirected by this CLI list. Skill paths supplied by the local application are local: use local_read to read them.",
    "Use local_bash for explicitly local shell work: environment=windows is Windows PowerShell, environment=host is the host shell (WSL bash when in WSL). Unlisted ordinary project commands default to remote bash.",
    "Use local_read for downloaded local text. PDF/Office/binary files require an appropriate local parser first. Read reference material locally unless a remote process needs the file.",
    "upload copies local files to remote; download copies remote files to local. Both accept explicit localPath and remotePath; directories require recursive=true. Remote paths stay in the remote workspace. No implicit sharing, source deletion, or background synchronization. An existing destination requires explicit overwrite=true and permission.",
    "Windows drive paths are supported for local reads/transfers on Windows and WSL. Never pass a Windows path to a remote tool. Split cross-machine pipelines into local execution, reading/transfer, and remote execution.",
    "The internal local mirror is implementation storage, not a download folder or transfer endpoint. State execution location and transfer paths in results.",
    "</local_remote_tools>",
  ].join("\n")

  // 3. Load remote AGENTS.md if exists
  let remoteAgents = ""
  try {
    const result = await ctx.sshPool.exec(
      `cat ${quoteShell(ctx.remoteWorkdir + "/AGENTS.md")} 2>/dev/null || echo "__NO_AGENTS_MD__"`,
      { timeout: 10_000 }
    )
    if (result.stdout.trim() && !result.stdout.includes("__NO_AGENTS_MD__")) {
      remoteAgents = `Instructions from: ${ctx.remoteWorkdir}/AGENTS.md\n${result.stdout.trim()}`
    }
  } catch {
    // ignore
  }

  // 4. Extract skills section from original system prompt
  const skillsSection = extractSkillsSection(originalSystem)

  // 5. Assemble the new system prompt
  const parts: string[] = [providerPrompt, envBlock]
  if (remoteAgents) parts.push(remoteAgents)
  if (skillsSection) parts.push(skillsSection)
  parts.push(routing)

  return [parts.join("\n\n")]
}

function extractSkillsSection(system: string[]): string | undefined {
  // Search from the end of the array backward — skills are typically the last section
  for (let i = system.length - 1; i >= 0; i--) {
    const text = system[i]
    const indexes = ["Skills provide specialized instructions", "<skills_instructions>", "<available_skills>"].map(marker => text.indexOf(marker)).filter(index => index >= 0)
    const idx = indexes.length ? Math.min(...indexes) : -1
    if (idx !== -1) {
      return text.slice(idx)
    }
  }
  return undefined
}
