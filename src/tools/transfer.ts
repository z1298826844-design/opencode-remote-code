import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { SFTPWrapper } from "ssh2"
import { tool } from "@opencode-ai/plugin"
import type { SSHPool } from "../ssh-pool.js"
import { localPath } from "../local-runtime.js"

interface Info { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
interface Side {
  path: typeof path.posix
  stat(file: string): Promise<Info | undefined>
  list(file: string): Promise<string[]>
  mkdir(file: string): Promise<void>
}
const missing = (error: unknown) => ["ENOENT", 2].includes((error as { code?: string | number }).code!)
const local: Side = {
  path,
  stat: file => fs.lstat(file).catch(error => { if (missing(error)) return undefined; throw error }),
  list: file => fs.readdir(file),
  mkdir: async file => { await fs.mkdir(file, { recursive: true }) },
}
function remoteSide(sftp: SFTPWrapper): Side {
  return {
    path: path.posix,
    stat: file => new Promise((resolve, reject) => sftp.lstat(file, (error, stat) => error ? missing(error) ? resolve(undefined) : reject(error) : resolve(stat))),
    list: file => new Promise((resolve, reject) => sftp.readdir(file, (error, entries) => error ? reject(error) : resolve(entries.map(e => e.filename)))),
    mkdir: async file => {
      const stat = await remoteSide(sftp).stat(file)
      if (stat) { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a regular directory: ${file}`); return }
      const parent = path.posix.dirname(file)
      if (parent !== file) await remoteSide(sftp).mkdir(parent)
      await new Promise<void>((resolve, reject) => sftp.mkdir(file, error => error ? reject(error) : resolve()))
    },
  }
}
async function checkAncestors(side: Side, file: string) {
  let parent = side.path.dirname(file)
  while (true) {
    const stat = await side.stat(parent)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Transfer refuses symlink/non-directory parent: ${parent}`)
    const next = side.path.dirname(parent)
    if (next === parent) break
    parent = next
  }
}
export function remoteTransferPath(value: string, root: string) {
  if (!value || /[\x00-\x1f]/.test(value)) throw new Error("Invalid remote transfer path")
  const result = path.posix.resolve(root, value)
  const relative = path.posix.relative(path.posix.resolve(root), result)
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) throw new Error("Remote transfer path must stay within the current remote workspace")
  return result
}

export function createTransferTool(direction: "upload" | "download", pool: SSHPool, root: string, host: string) {
  return tool({
    description: `${direction === "upload" ? "Upload LOCAL files/directories to the current REMOTE workspace" : "Download REMOTE workspace files/directories to LOCAL storage"} over SFTP. localPath and remotePath are EXACT source/destination paths (no implicit basename). Directories require recursive=true; existing files require overwrite=true and permission. Symlinks/special files are refused. Files are copied, never removed from the source. This is separate from the internal mirror.`,
    args: {
      localPath: tool.schema.string(), remotePath: tool.schema.string(),
      recursive: tool.schema.boolean().optional(), overwrite: tool.schema.boolean().optional(),
    },
    async execute(args, ctx) {
      const lp = await localPath(args.localPath)
      const rp = remoteTransferPath(args.remotePath, root)
      ctx.abort.throwIfAborted()
      return pool.withSftp(async sftp => {
        const abort = () => sftp.end()
        ctx.abort.addEventListener("abort", abort, { once: true })
        const timer = setTimeout(abort, 600_000)
        try {
          const remote = remoteSide(sftp)
          const source = direction === "upload" ? local : remote
          const destination = direction === "upload" ? remote : local
          const src = direction === "upload" ? lp : rp, dst = direction === "upload" ? rp : lp
          await checkAncestors(source, src)
          await checkAncestors(destination, dst)
          const files: Array<{ src: string; dst: string; exists: boolean }> = []
          const dirs: string[] = []
          async function walk(from: string, to: string) {
            ctx.abort.throwIfAborted()
            const stat = await source.stat(from)
            if (!stat) throw new Error(`Source does not exist: ${from}`)
            if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Transfer refuses symlinks/special files: ${from}`)
            const existing = await destination.stat(to)
            if (existing?.isSymbolicLink()) throw new Error(`Destination is a symlink: ${to}`)
            if (stat.isDirectory()) {
              if (!args.recursive) throw new Error("Directory transfer requires recursive=true")
              if (existing && !existing.isDirectory()) throw new Error(`Destination is not a directory: ${to}`)
              dirs.push(to)
              if (dirs.length > 10000) throw new Error("Transfer directory limit exceeded (10000)")
              for (const name of await source.list(from)) {
                if (name === "." || name === "..") continue
                if (!name || /[\\/\x00-\x1f]/.test(name) || (direction === "download" && process.platform === "win32" && /[:*?"<>|]/.test(name))) throw new Error("Unsupported filename in transfer")
                await walk(source.path.join(from, name), destination.path.join(to, name))
              }
            } else {
              if (existing && (!existing.isFile() || !args.overwrite)) throw new Error(`Destination exists; choose a new path or explicitly set overwrite=true: ${to}`)
              files.push({ src: from, dst: to, exists: Boolean(existing) })
              if (files.length > 10000) throw new Error("Transfer file limit exceeded (10000)")
            }
          }
          await walk(src, dst)
          await ctx.ask({ permission: direction, patterns: [lp, rp], always: [], metadata: { localPath: lp, remotePath: rp, remoteHost: host, files: files.length, directories: dirs.length, overwrite: files.filter(f => f.exists).map(f => f.dst) } })
          ctx.abort.throwIfAborted()
          for (const dir of dirs) { await checkAncestors(destination, dir); await destination.mkdir(dir) }
          let completed = 0
          try {
            for (const file of files) {
              ctx.abort.throwIfAborted()
              await checkAncestors(source, file.src)
              await checkAncestors(destination, file.dst)
              await destination.mkdir(destination.path.dirname(file.dst))
              const temp = destination.path.join(destination.path.dirname(file.dst), `.opencode-transfer-${randomUUID()}.tmp`)
              try {
                if (direction === "upload") {
                  await new Promise<void>((resolve, reject) => sftp.fastPut(file.src, temp, error => error ? reject(error) : resolve()))
                  // POSIX rename replaces atomically; standard SFTP rename refuses existing files.
                  if (args.overwrite) await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(temp, file.dst, error => error ? reject(new Error(`Atomic overwrite unavailable: ${error.message}`)) : resolve()))
                  else await new Promise<void>((resolve, reject) => sftp.rename(temp, file.dst, error => error ? reject(error) : resolve()))
                } else {
                  await new Promise<void>((resolve, reject) => sftp.fastGet(file.src, temp, error => error ? reject(error) : resolve()))
                  if (args.overwrite) await fs.rename(temp, file.dst)
                  else await fs.link(temp, file.dst) // Atomic no-clobber publish, on the destination filesystem.
                }
                completed++
              } finally {
                if (direction === "upload") await new Promise<void>(resolve => sftp.unlink(temp, () => resolve())).catch(() => {})
                else await fs.rm(temp, { force: true }).catch(() => {})
              }
            }
          } catch (error) { throw new Error(`${direction} stopped after ${completed}/${files.length} files; completed files remain. ${(error as Error).message}`) }
          return { title: `${direction}: ${files.length} files`, output: `Direction: ${direction === "upload" ? "local → remote" : "remote → local"}\nLocal path: ${lp}\nRemote: ${host}:${rp}\nCompleted: ${completed} files, ${dirs.length} directories.`, metadata: { localPath: lp, remotePath: rp, files: completed } }
        } finally { clearTimeout(timer); ctx.abort.removeEventListener("abort", abort) }
      })
    },
  })
}
