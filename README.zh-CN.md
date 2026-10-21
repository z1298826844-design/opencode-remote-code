# 🌐 Remote Code

[English](README.md)

一款 OpenCode 插件，让 AI Agent 能够通过 SSH 直接操控远程机器——**远程端零依赖**，仅需 SSH 守护进程即可。无需在远程安装任何 agent、运行时或依赖。

对 AI 而言，一切感知与本地无异：它调用的仍然是 `bash`、`edit`、`write`、`read`、`glob`、`grep` 和 `apply_patch`。

---

## 🚀 安装与启动

本地准备 **Node.js 20+（含 npm）**、**Git** 和 **OpenCode CLI**，确认 `opencode --version` 可用。远程机器只需要 SSH 服务；本地不需要 `sshpass` 或 `rsync`。

```bash
git clone https://github.com/zz6zz666/opencode-remote-code.git
cd opencode-remote-code
npm run setup
```

`setup` 会安装依赖、构建插件、注册 OpenCode 插件和全局命令，并在结束时显示后续指引。如果 npm 的全局命令目录不在 `PATH` 中，会显示该目录和设置方法。

**然后在任意目录运行：**

```bash
opencode-remote
```

没有连接记录时，会引导新建连接：先填写一个名称（例如“开发服务器”），再分别填写 **IP/主机名、端口、账号、密码或密钥**，脚本自动生成连接配置。端口默认 **22**，直接回车即可；其他已有值也可回车保留。按 Ctrl+C 可随时退出：

```text
连接名称：开发服务器

[1/4] 连接哪台远程机器？
服务器 IP / 主机名（必填）：192.168.1.10
SSH 端口 [回车使用：22]：
登录账号（必填）：alice

[2/4] 如何登录？
  1. 密码登录（默认）
  2. SSH 密钥
认证方式（1=密码，2=密钥） [回车使用：1]：
SSH 登录密码：
是否记住SSH 登录密码（y=是，n=否，回车默认否）：

[3/4] 要操作远程机器上的哪个目录？
远程工作目录（必填）：/home/alice/project

[4/4] 是否需要为 sudo 命令提供密码？
需要 sudo 密码吗（y=是，n=否，回车默认否）：
```

密码输入时不会显示字符或星号，输入完成后按回车提交。选择需要 sudo 后，还会单独询问 sudo 密码及是否记住。**SSH 登录密码与 sudo 密码彼此独立**，不用 sudo 也可以使用密码登录。

选择 **2（SSH 密钥）** 时，按提示填写本机私钥路径，例如 `~/.ssh/id_ed25519`、`~/.ssh/id_rsa` 或 `C:\Users\me\My Keys\id_rsa`，无需加引号或填写 SSH 参数。常用路径存在时会自动提供默认值；请选择私钥，而非 `.pub` 公钥。也可输入 `agent` 使用当前 `SSH_AUTH_SOCK` 指向的 SSH agent；有口令的密钥请先载入 agent，再选择此方式。

**每次启动先选服务器，再确认本次工作目录：**

```text
已保存的连接：
  1. 开发服务器    alice@192.168.1.10:22（上次选择）
     上次工作目录：/home/alice/project-a
  2. 测试服务器    root@192.168.1.20:2222
     上次工作目录：/srv/test
  0. 新建连接
请选择连接编号 [回车使用：1]：

上次工作目录：/home/alice/project-a
本次远程工作目录 [回车使用：/home/alice/project-a]：
```

选择连接时回车使用上次选择的服务器，输入 `0` 新建连接。目录每次都会询问：回车沿用这台服务器上次的路径，输入新的绝对路径则使用并记住新路径；首次没有历史路径时必须填写。每条连接的目录独立记录。

确认目录后读取或询问密码，再启动 OpenCode。成功记住的密码自动读取；未记住则隐藏输入。密钥登录且无需 sudo 密码时不再询问密码。旧版单连接配置会自动迁移为第一条连接，保留原目录和密码记忆设置；同一服务器、同一目录继续复用原会话历史。

安装与启动命令在 Linux、macOS、Windows 上相同。安装使用 `npm link`，**请保留源码目录**；移动目录后重新运行 `npm run setup`。原有 `launchers/remote-opencode.sh`、`.ps1`、`.bat` 仍可使用，会转交给同一个命令入口。

## ⚙️ 修改配置

打开连接管理菜单：

```bash
opencode-remote config
```

菜单提供 **新建连接、修改连接、删除连接、查看连接列表**。修改和删除时先选择连接；删除需要确认，并保留会话历史和系统凭据（多个连接可能共用凭据）。如需清除密码，使用 `config forget-password`。

也可以单独修改**上次选择的连接**，`workdir` 是它下次启动时提示的默认目录：

```bash
opencode-remote config set workdir /home/project
opencode-remote config set sudo true
```

| 命令 | 用途 |
| :--- | :--- |
| `opencode-remote config new` | 直接新建连接 |
| `opencode-remote config list` | 查看全部连接和各自上次的目录 |
| `opencode-remote config show` | 查看连接列表及上次选择连接的配置来源，不显示密码 |
| `opencode-remote config unset <配置项>` | 删除保存值，恢复默认或下次填写 |
| `opencode-remote config forget-password` | 清除所有登记目标的已记住密码 |
| `opencode-remote config reset` | 确认后清空配置和密码，保留会话历史 |
| `opencode-remote doctor` | 检查 OpenCode、插件注册、SSH 认证和远程目录，不执行 sudo |
| `opencode-remote --help` | 查看操作指引和示例 |
| `opencode-remote --version` | 查看版本 |

连接配置保存到 `~/.config/opencode-remote/config.json`（设置了 `XDG_CONFIG_HOME` 时使用该目录）。环境变量优先于保存值；`config show` 会显示来源。清除保存配置不会清除当前 shell 中的环境变量。

**密码记忆**使用系统凭据库：macOS Keychain、Windows Credential Manager、Linux Secret Service（如 GNOME Keyring/KWallet）。Linux 需要可用且已解锁的桌面凭据服务。服务不可用时会提示，本次仍可输入密码连接，不会退回明文存储。密码按远程主机、账号和端口区分；更换服务器或账号不会使用其他目标的密码。

要更新已记住的密码，运行 `opencode-remote config`；要取消记忆，在向导中选择不记住，或运行 `config forget-password`。凭据库锁定导致删除失败时，命令会报错并保留索引，解锁后重试即可。

<details>
<summary>高级配置与自动化</summary>

需要自定义 SSH 选项时，仍可设置完整连接命令，例如：

```bash
opencode-remote config set ssh "ssh -oHostKeyAlgorithms=+ssh-rsa -p 2222 alice@host"
```

交互向导会读取旧连接配置，回填地址、端口、账号和密钥路径，并保留已有的其他 SSH 选项。

| 配置项 | 环境变量 | 默认值 |
| :--- | :--- | :--- |
| `ssh` | `REMOTE_SSH` | 向导自动生成；高级用法可填完整 SSH 命令 |
| `workdir` | `REMOTE_WORKDIR` | 必填，远程绝对路径 |
| `auth` | `REMOTE_AUTH` | `password`；未指定且 SSH 含 `-i` 时为 `key` |
| `sudo` | `REMOTE_SUDO` | `false` |
| `mirror` | `REMOTE_MIRROR` | `~/.opencode/mirrors/` |
| `pool-command-size` | `REMOTE_POOL_COMMAND_SIZE` | `3` |
| `pool-file-size` | `REMOTE_POOL_FILE_SIZE` | `2` |
| `pool-stagger-ms` | `REMOTE_POOL_STAGGER_MS` | `0` 毫秒 |

密码可通过 `REMOTE_PASSWORD` 和 `REMOTE_SUDO_PASSWORD` 提供，环境变量中的密码不会自动记住。未显式设置 `REMOTE_SUDO` 时，提供 `REMOTE_SUDO_PASSWORD` 会启用 sudo 密码配置。交互启动时，显式设置 `REMOTE_SSH` 会跳过连接选择，设置 `REMOTE_WORKDIR` 会跳过目录询问；环境变量不会覆盖文件中保存的目录。无人值守运行有多个连接时，必须通过 `REMOTE_SSH` 明确指定目标，并建议同时提供 `REMOTE_WORKDIR` 和所需凭据，避免误用上次连接。

```bash
opencode-remote config set pool-command-size 2
opencode-remote config set pool-stagger-ms 200
```

传递 OpenCode 参数时使用 `--` 分隔：

```bash
opencode-remote -- --continue
opencode-remote -- run "查看远程项目结构"
```

启动器根据远程主机和工作目录进入固定的本地目录 `~/.opencode/remote-sessions/<host>_<workdir_slug>/`，避免从不同目录启动时找不到会话。已有普通主机名与路径对应的会话目录保持不变。

插件仍只通过环境变量激活；不设置 `REMOTE_SSH` 时，直接运行 `opencode` 继续使用本地模式。

</details>

## 🔧 更新、排错与卸载

更新时在源码目录运行：

```bash
git pull
npm run setup
```

遇到问题先运行 `opencode-remote doctor`。找不到全局命令时，按 setup 输出把 npm 全局命令目录加入 `PATH` 并重开终端；也可在源码目录临时运行 `npm run remote`。连接失败时运行 `opencode-remote config` 检查 SSH、认证方式和目录。SSH 命令作为连接参数解析，支持常用 `-p`、`-i`、`-l` 与现有 `-o` 算法设置，不执行本地 shell，也不读取完整的 OpenSSH 配置或实现所有 SSH 选项。

卸载前可选择清除配置和密码，然后移除插件入口与全局命令：

```bash
opencode-remote config reset
# 在源码目录执行：
npm run unregister
npm uninstall -g opencode-remote-code
```

`config reset` 会询问确认，不删除会话历史。只想卸载并保留连接配置时，跳过第一行。自定义 `OPENCODE_CONFIG_DIR` 的用户，在安装、启动、卸载时使用相同的设置。插件通过独立的入口文件注册，不改写现有 `opencode.json`；从旧版迁移时，请移除手工添加的重复插件配置。

开发验证：`npm run lint`、`npm run test:cli`。CLI 测试不需要外部 SSH 目标；原有 SSH 端到端测试仍使用 `.env.test`。

---

## 💡 为什么需要 Remote Code？

我是一名模拟 IC 工程师。日常工作依赖 **Cadence IC6.1.7 设计套件**，它运行在一台古老的 **CentOS 6 虚拟机**上。CentOS 6 的 glibc 版本无法安装任何现代化 agent 工具，Node.js、Python 3.11+ 甚至大多数现代 CLI 工具都无法运行。

我需要在本地 Windows 主机使用 OpenCode 来操控这台虚拟机——自动化设计流程、批量修改原理图参数、运行仿真脚本。**Remote Code** 让这一切成为可能：AI 以为自己在直接操作本地文件，实际上每个命令都在那台古老的虚拟机上执行。

![pic](pic.png)

**无需触碰虚拟机上的任何一个文件，只需 SSH 服务在运行。**

| 场景                           | 痛点                       | Remote Code 的解法     |
| :----------------------------- | :------------------------- | :--------------------- |
| 老旧虚拟机（CentOS 6、RHEL 5） | 无法安装现代 agent         | 仅需 SSH               |
| 生产服务器                     | 合规严格，禁止随意安装软件 | 远程不留任何痕迹       |
| 嵌入式/边缘设备                | 资源受限，无包管理器       | 所有智能逻辑在本地运行 |
| 远程 Windows 主机              | 只需安装 OpenSSH           | 统一操控入口           |
| 容器/临时环境                  | 不想反复配置               | 即连即用，退出无残留   |

---

## 🔌 独立 MCP Server

当前仓库是 **OpenCode 插件版**：
<https://github.com/zz6zz666/opencode-remote-code>

同一 GitHub 账号下也会有独立 MCP server 版本：
<https://github.com/zz6zz666/mcp-remote-code>

两个项目有相同的零侵入 SSH 动机，但面向不同工作流：

- **OpenCode 插件版**：深度绑定 OpenCode。它覆盖原生工具，把远端机器完全伪装成 agent workspace。运行时环境完全在远端，本地目录不会自然进入 agent 的普通视野。
- **MCP server 版**：向任意 MCP 客户端暴露带命名空间的 `remote_*` 工具。本地和远端工作可以并存，agent 可以在本地维护设计笔记或查找表，同时在 SSH 目标上执行远端命令、编辑、patch、pull、push 和仿真任务。

---

## ⚙️ 工作原理

### 1. 本地镜像

Remote Code **不做全量目录镜像**，只同步 AI 实际触碰过的文件。镜像目录结构：

```
~/.opencode/mirrors/
└── root_192.168.184.135/
    └── home_project/
        ├── manifest.json          # 触碰文件清单
        └── home/project/          # 镜像目录树
            └── src/
                └── main.ts
```

### 2. 路径映射

**AI 看到的所有路径都是远程绝对路径**。插件在后台透明转换：

```
AI 看到:     /home/project/src/main.ts
本地路径:    ~/.opencode/mirrors/root_192.168.184.135/home_project/home/project/src/main.ts
```

### 3. 同步引擎

文件编辑类工具（`read`、`write`、`edit`、`apply_patch`）在本地镜像上操作，通过 SFTP 借助持久 SSH 连接同步：

- **编辑前** → `pullAll()` 确保本地镜像与远程一致
- **编辑后** → `pushAll()` 将修改上传到远程

命令执行类工具（`bash`、`glob`、`grep`）直接通过 SSH 在远程执行。

### 4. SSH 架构

插件使用 `ssh2` 库维护连接池：

- **命令池**（默认 3 个连接）：用于 `bash`、`glob`、`grep` 执行
- **文件池**（默认 2 个连接）：用于 SFTP 文件传输

不需要外部 `ssh`、`sshpass` 或 `rsync` 可执行文件。

---

## 📊 工具行为矩阵

| 工具            | 执行位置 | 同步                     | 说明                                                                |
| :-------------- | :------- | :----------------------- | :------------------------------------------------------------------ |
| `bash`        | 远程 SSH | 无                       | 命令直接转发到远程 shell                                            |
| `glob`        | 远程 SSH | 无                       | 远程 `rg --files --sortr=modified`（fallback 到 `find + stat`） |
| `grep`        | 远程 SSH | 无                       | 远程 `rg --json`（fallback 到 `grep -rn`）                      |
| `read`        | 本地镜像 | 执行前 pull              | 读取已同步的镜像文件                                                |
| `write`       | 本地镜像 | 条件 pull，执行后 push   | 本地写入后上传                                                      |
| `edit`        | 本地镜像 | 执行前 pull，执行后 push | 本地精确替换后上传                                                  |
| `apply_patch` | 本地镜像 | 执行前 pull，执行后 push | 本地应用 patch 后上传                                               |

---

## 🔒 安全边界

- **路径安全**：`PathMapper` 校验本地路径不超出镜像根目录，`../` 穿透会被拒绝。
- **命令安全**：`bash` 工具的动态参数尽量直接通过 SSH 传递，避免本地 shell 插值。
- **权限边界**：远程操作权限与 SSH 用户一致，不提升权限。
- **工作目录**：操作非工作目录内的文件时触发 OpenCode 原生确认流程。

---

## ⚠️ 局限性

| 局限               | 影响                                                             | 缓解                              |
| :----------------- | :--------------------------------------------------------------- | :-------------------------------- |
| 大文件首次访问延迟 | 单个大文件首次下载需等待                                         | 后续 SFTP 仅传差异                |
| 无远程 LSP         | 远程文件无语言服务器诊断                                         | 非基本编辑的必需功能              |
| 远程环境依赖       | `glob`/`grep` 优先远程 `rg`，fallback 到 `find`/`grep` | 绝大多数 Linux 发行版内置         |
| 并发编辑安全       | `edit` 工具带 per-file 锁，同一文件并发编辑自动串行化          | `bash`/`glob`/`grep` 无状态 |
| 二进制文件         | `read` 通过扩展名 + 内容采样检测二进制文件                     | 二进制文件请用 `bash` 工具查看  |
| BOM 处理           | `read`/`write`/`edit`/`patch` 自动保留 UTF-8 BOM         | 完全透明，无需用户干预            |

---

## 📄 许可

MIT
