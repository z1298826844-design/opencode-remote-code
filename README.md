# 🌐 Remote Code

[中文](README.zh-CN.md)

An OpenCode plugin that lets AI agents operate remote machines over SSH — with **zero footprint** on the remote side. The remote machine only needs `sshd`; no agent, runtime, or dependency installation is required.

The AI sees nothing different: it still calls `bash`, `edit`, `write`, `read`, `glob`, `grep`, and `apply_patch` exactly as it would locally.

---

## 🚀 Install and connect

Install **Node.js 20+ (with npm)**, **Git**, and the **OpenCode CLI** locally. Check that `opencode --version` works. The remote machine only needs an SSH daemon; local `sshpass` and `rsync` are not required.

```bash
git clone https://github.com/zz6zz666/opencode-remote-code.git
cd opencode-remote-code
npm run setup
```

Setup installs dependencies, builds the plugin, registers it with OpenCode, and registers the global command. It finishes with next-step instructions, including how to add npm's global command directory to `PATH` if necessary.

**Then, from any directory:**

```bash
opencode-remote
```

The first-run wizard uses four numbered steps with examples: the SSH command, remote absolute directory, authentication method (password or key), and whether sudo needs a password. Required fields and Enter defaults are displayed beside the input. Press Ctrl+C to cancel. Password prompts remain visible, but typed passwords display no characters or asterisks; press Enter to submit. Each password has a separate choice to remember it. **SSH login and sudo passwords are independent**: password login works without enabling sudo.

Later launches reuse your connection settings. Remembered passwords are retrieved automatically; otherwise the launcher prompts each time. Key authentication uses `-i` or an agent referenced by `SSH_AUTH_SOCK`. Load passphrase-protected keys into your SSH agent first.

```text
ssh -p 2222 user@host
ssh -i /absolute/path/id_rsa user@host
ssh -i "C:\Users\me\My Keys\id_rsa" user@host
```

The install and launch commands are the same on Linux, macOS, and Windows. Setup uses `npm link`, so **keep the source directory**. Rerun `npm run setup` after moving it. The existing `launchers/remote-opencode.sh`, `.ps1`, and `.bat` scripts remain compatibility wrappers for the same CLI. Terminal prompts currently use Chinese; command names and configuration keys are shown below.

## ⚙️ Change configuration

Use the interactive editor; press Enter to keep a current value:

```bash
opencode-remote config
```

Or update individual settings:

```bash
opencode-remote config set ssh "ssh -p 2222 user@new-host"
opencode-remote config set workdir /home/project
opencode-remote config set auth key
opencode-remote config set sudo true
```

| Command | Purpose |
| :--- | :--- |
| `opencode-remote config show` | Show settings and their sources, without revealing passwords |
| `opencode-remote config unset <key>` | Remove a saved value; use its default or prompt next time |
| `opencode-remote config forget-password` | Delete remembered passwords for all tracked targets |
| `opencode-remote config reset` | Confirm, then clear settings and passwords; keep session history |
| `opencode-remote doctor` | Check OpenCode, plugin registration, SSH authentication, and remote directory access; never run sudo |
| `opencode-remote --help` | Show usage and examples |
| `opencode-remote --version` | Show the version |

Settings live in `~/.config/opencode-remote/config.json`, or under `XDG_CONFIG_HOME` when set. Environment variables override saved settings; `config show` identifies the source. Clearing saved settings does not unset variables in your shell.

**Remembered passwords** use the OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service (such as GNOME Keyring/KWallet). Linux needs an available, unlocked credential service. If unavailable, the launcher explains the failure and lets you connect with the entered password; it never falls back to plaintext storage. Credentials are bound to the remote host, username, and port, so switching targets does not reuse another target's password.

Run `opencode-remote config` to replace a remembered password or stop remembering it. `config forget-password` clears all tracked passwords. Failed deletions retain their indexes and report an error; unlock the credential service and retry.

<details>
<summary>Advanced configuration and automation</summary>

| Setting | Environment variable | Default |
| :--- | :--- | :--- |
| `ssh` | `REMOTE_SSH` | Required; SSH command string |
| `workdir` | `REMOTE_WORKDIR` | Required; remote absolute path |
| `auth` | `REMOTE_AUTH` | `password`; inferred as `key` when unset and SSH includes `-i` |
| `sudo` | `REMOTE_SUDO` | `false` |
| `mirror` | `REMOTE_MIRROR` | `~/.opencode/mirrors/` |
| `pool-command-size` | `REMOTE_POOL_COMMAND_SIZE` | `3` |
| `pool-file-size` | `REMOTE_POOL_FILE_SIZE` | `2` |
| `pool-stagger-ms` | `REMOTE_POOL_STAGGER_MS` | `0` milliseconds |

Supply passwords through `REMOTE_PASSWORD` and `REMOTE_SUDO_PASSWORD` for automation; these are never automatically remembered. Providing `REMOTE_SUDO_PASSWORD` enables the sudo-password configuration unless `REMOTE_SUDO` is explicitly set. Unattended launches need all required settings and credentials in advance; missing interactive input produces an immediate error.

```bash
opencode-remote config set pool-command-size 2
opencode-remote config set pool-stagger-ms 200
```

Pass OpenCode arguments after `--`:

```bash
opencode-remote -- --continue
opencode-remote -- run "Inspect the remote project"
```

Launchers enter a stable directory at `~/.opencode/remote-sessions/<host>_<workdir_slug>/`, so session history stays accessible regardless of the invocation directory. Existing session paths for ordinary host/path combinations are preserved.

The plugin is activated only through environment variables. With `REMOTE_SSH` unset, launching plain `opencode` keeps local mode.

</details>

## 🔧 Update, troubleshoot, and uninstall

Update from the source directory:

```bash
git pull
npm run setup
```

Start troubleshooting with `opencode-remote doctor`. If the command is missing, follow setup's instructions to add npm's global command directory to `PATH` and reopen the terminal. You can also run `npm run remote` from the source directory. For connection failures, use `opencode-remote config` to check SSH, authentication, and the remote path. SSH strings are parsed as connection data, supporting common `-p`, `-i`, `-l`, and existing `-o` algorithm settings. They do not execute a local shell or implement the full OpenSSH configuration/options system.

Optionally clear saved configuration and credentials before uninstalling, then remove the plugin loader and global command:

```bash
opencode-remote config reset
# From the source directory:
npm run unregister
npm uninstall -g opencode-remote-code
```

Reset asks for confirmation and preserves session history. Skip the first command to keep settings. If you use `OPENCODE_CONFIG_DIR`, keep it consistent during setup, launch, and removal. Registration uses a separate plugin entry file and leaves `opencode.json` intact. When migrating from an older manual installation, remove duplicate plugin entries you previously added.

Development checks: `npm run lint` and `npm run test:cli`. CLI tests do not need an external SSH server; the existing live SSH suites still use `.env.test`.

---

## 💡 Why Remote Code?

I am an analog IC engineer. My daily work relies on the **Cadence IC6.1.7 design suite**, which runs on an aging **CentOS 6 VM**. The glibc version on CentOS 6 is too old to install any modern agent tools — Node.js, Python 3.11+, and most modern CLI tools simply won't run.

I need to use OpenCode on my local Windows host to control that VM — automating design flows, batch-modifying schematic parameters, running simulation scripts. **Remote Code** makes this possible: the AI thinks it is operating local files, but every command actually executes on that ancient VM.

![pic](pic.png)

**Not a single file needs to be touched on the VM — only the SSH service must be running.**

| Scenario                      | Pain Point                               | Remote Code Solution            |
| :---------------------------- | :--------------------------------------- | :------------------------------ |
| Legacy VMs (CentOS 6, RHEL 5) | Cannot install modern agents             | Only needs SSH                  |
| Production servers            | Strict compliance, no installs           | Leaves no trace on remote       |
| Embedded / edge devices       | No package manager, resource constrained | All logic runs locally          |
| Remote Windows hosts          | Just install OpenSSH                     | Single entry point              |
| Ephemeral containers          | Don't want repeated setup                | Connect on demand, zero residue |

---

## 🔌 Standalone MCP Server

This repository is the **OpenCode plugin** version:
<https://github.com/zz6zz666/opencode-remote-code>

There is also a standalone MCP server version planned for the same GitHub
account:
<https://github.com/zz6zz666/mcp-remote-code>

The two projects share the same zero-footprint SSH motivation, but target
different workflows:

- **OpenCode plugin**: tightly integrated with OpenCode. It overrides native
  tools so the remote machine is fully masqueraded as the agent workspace. The
  runtime environment is remote, and local directories are intentionally not
  part of the agent's normal view.
- **MCP server**: exposes namespaced `remote_*` tools to any MCP client. Local
  and remote work can coexist, so an agent can keep local design notes or lookup
  tables while running remote commands, edits, patches, pulls, pushes, and
  simulations on the SSH target.

---

## ⚙️ How It Works

### 1. Local Mirror

Only files the AI actually touches are mirrored locally. The mirror is kept at:

```
~/.opencode/mirrors/
└── user_host/
    └── home_project/
        ├── manifest.json          # tracked file list
        └── home/project/          # mirrored directory tree
            └── src/
                └── main.ts
```

### 2. Path Mapping

All paths visible to the AI are **remote absolute paths**. The plugin translates them transparently:

```
AI sees:     /home/project/src/main.ts
Local path:  ~/.opencode/mirrors/user_host/home_project/home/project/src/main.ts
```

### 3. Sync Engine

File-editing tools (`read`, `write`, `edit`, `apply_patch`) operate on the local mirror and sync via SFTP over persistent SSH connections:

- **Before** a file edit → `pullAll()` ensures the local mirror is up to date
- **After** a file edit → `pushAll()` uploads changes to the remote

Command tools (`bash`, `glob`, `grep`) run directly on the remote via SSH.

### 4. SSH Architecture

The plugin uses the `ssh2` library to maintain connection pools:

- **Command pool** (3 connections by default): for `bash`, `glob`, `grep` execution
- **File pool** (2 connections by default): for SFTP file transfers

No external `ssh`, `sshpass`, or `rsync` binaries are required.

---

## 📊 Tool Behavior Matrix

| Tool            | Where it runs | Sync                       | Notes                                                                |
| :-------------- | :------------ | :------------------------- | :------------------------------------------------------------------- |
| `bash`        | Remote SSH    | none                       | Direct shell forwarding                                              |
| `glob`        | Remote SSH    | none                       | Remote `rg --files --sortr=modified` (fallback to `find + stat`) |
| `grep`        | Remote SSH    | none                       | Remote `rg --json` (fallback to `grep -rn`)                      |
| `read`        | Local mirror  | pull before                | Reads from synced mirror                                             |
| `write`       | Local mirror  | pull if exists, push after | Writes to mirror then uploads                                        |
| `edit`        | Local mirror  | pull before, push after    | Exact replacement on mirror                                          |
| `apply_patch` | Local mirror  | pull before, push after    | Applies patch on mirror                                              |

---

## 🔒 Security Boundaries

- **Path containment**: `PathMapper` validates that resolved local paths never escape the mirror root (`../` is rejected).
- **Command safety**: Dynamic arguments to `bash` are passed through SSH without local shell interpolation when possible.
- **Privilege scope**: Remote operations run with the SSH user's permissions — no elevation.
- **Workspace boundary**: Operations outside `REMOTE_WORKDIR` follow OpenCode's native permission confirmation flow.

---

## ⚠️ Limitations

| Limitation                      | Impact                                                                         | Mitigation                               |
| :------------------------------ | :----------------------------------------------------------------------------- | :--------------------------------------- |
| Large file first-access latency | First download of a >100 MB file waits for SFTP                                | Subsequent edits use delta sync          |
| No remote LSP                   | No language-server diagnostics for remote files                                | Not required for basic editing           |
| Remote tool dependencies        | `glob`/`grep` prefer remote `rg`, fallback to `find`/`grep`          | Present on virtually all Linux distros   |
| Concurrent edit safety          | `edit` tool has per-file locks; concurrent edits on same file are serialized | `bash`/`glob`/`grep` are stateless |
| Binary files                    | `read` detects binaries by extension + content sampling                      | Use `bash` tools for binary inspection |
| BOM handling                    | UTF-8 BOM is preserved across `read`/`write`/`edit`/`patch`            | Works transparently                      |

---

## 📄 License

MIT
