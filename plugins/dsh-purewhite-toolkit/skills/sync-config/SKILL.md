---
name: sync-config
description: "对比本机 DSH 实装环境与云端仓库 PureWhite202/my-dsh 的差异（插件、技能、全局指令），把两边谁多谁少说清楚；需要时拉取或推送（macOS 走 SSH，Windows 走 HTTPS + Git 凭据）。用户输入 /sync-config，或说「对比本机和云端」「同步个人配置」「仓库里是不是少了什么」时使用。"
---

# 同步个人配置（sync-config）

## 这个技能解决什么

本机有一份 DSH 环境的存档仓库，GitHub 上是 `PureWhite202/my-dsh`。时间一长，本机装的东西和仓库里存的东西会两头不一致：仓库里有的插件本机没装、本机新装的插件没进仓库、全局指令各有各的版本。

这个技能的工作只有一件事：**把本机实装环境和云端仓库摊开对比，报告差异，然后停下来**。不带参数、不做修改、不预设方向。

## 仓库与连接

### 先定位仓库，不要假设路径

克隆位置随平台和装机方式变化，**先探测再操作**：

| 平台 | 常见位置 |
|---|---|
| macOS | `~/.dsh/my-dsh` |
| Windows | 不一定在 `~/.dsh` 下。常见于 `D:\Document\deepseek-harness\default-workspace\<工作区>\`，`plugins/dsh-purewhite-toolkit` 所在的那个 git 工作树就是它 |

探测命令（找到就把它记成 `$REPO`，后面所有 `git -C` 都用它）：

```bash
# 1) 先试默认位置
git -C ~/.dsh/my-dsh rev-parse --show-toplevel

# 2) 失败则从插件目录往上找
git -C <dsh-purewhite-toolkit 所在目录> rev-parse --show-toplevel
```

远端统一是 `PureWhite202/my-dsh.git`，默认分支 `main`。**拉推方式按平台选**：

| 平台 | 方式 | 前置条件 |
|---|---|---|
| macOS | SSH | `~/.ssh/id_ed25519_github` 存在，公钥已加到 GitHub |
| Windows | HTTPS + Git 凭据 | `git config --global credential.helper` 已配置 |

先看一眼当前走哪条：

```bash
git -C $REPO remote get-url origin
```

`https://…` 就是 HTTPS 路线，`git@…` 才是 SSH 路线。**不要对着 https 的 remote 去调 SSH 密钥**，两套凭据互不相干。

### macOS：SSH

- 远端：`git@github.com:PureWhite202/my-dsh.git`
- 私钥：`~/.ssh/id_ed25519_github`，公钥是同目录的 `id_ed25519_github.pub`
- 自检：`ssh -T git@github.com`，正常回 `Hi PureWhite202! You've successfully authenticated, but GitHub does not provide shell access.`

如果 origin 还是 https，切到 SSH：

```bash
git -C $REPO remote set-url origin git@github.com:PureWhite202/my-dsh.git
```

换机器时 SSH 不通：`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -C "dsh"` 生成密钥，把 `.pub` 内容加到 GitHub → Settings → SSH and GPG keys，再用 `ssh -T git@github.com` 验证。

### Windows：HTTPS + 凭据存储

Windows 上不一定要配 SSH，**HTTPS + Git 凭据助手**更省事。先看现在用哪个助手：

```powershell
git config --global --get credential.helper
```

| 返回值 | 含义 | 处理 |
|---|---|---|
| `manager` | Git Credential Manager（Git for Windows 默认），凭据加密存在系统凭据库，首次 push 弹窗登录 | 推荐，保持不动 |
| `store` | 明文存在 `%USERPROFILE%\.git-credentials` | 能用，但 token 明文落盘 |
| 空 | 没配 | 按下面配一个 |

配置（二选一）：

```powershell
# 推荐：系统凭据管理器，加密存储
git config --global credential.helper manager

# 简单：明文文件（仅限个人机器）
git config --global credential.helper store
```

配 `store` 后首次 push 需要输入一次用户名和 **Personal Access Token**（GitHub 已不支持账号密码），之后写进 `%USERPROFILE%\.git-credentials`，格式：

```
https://<用户名>:<token>@github.com
```

验证凭据可用（不会真的改动远端）：

```powershell
git -C $REPO push --dry-run origin main
```

看到 `e93ba3d..eef0f93  main -> main` 这类输出就是通行；报 `Authentication failed` 说明凭据没配好或 token 过期。

> **Windows 上的注意事项**
> `ssh -T git@github.com` 报 `Permission denied (publickey)` 是**正常现象**（这台机器压根没配 SSH 密钥），不代表仓库有问题。此时别把 remote 改成 SSH，否则本来能推的也推不了了。

## 本机 = 实装环境

- **插件**：`~/.dsh/profiles/<当前 profile>/package.json` 里的 `dependencies`（常见是 `desktop`），**排除 `@deepseek-ai/` 开头的官方包**；同一文件的 `dsh.profile.bundles` 是 bundle 启用顺序，可参考对照。
- **技能**：`~/.agents/skills` 与 `~/.dsh/skills` 下的目录名（两边取并集）。
- **全局指令**：`~/.dsh/AGENTS.md`。

## 云端 = 远端 origin/main

不要把本地工作树当成「云端」——工作树里有别人（或你自己）没提交的改动。正确做法是先 `git fetch`，再用 `git ls-tree` / `git show` 读 `origin/main` 的内容。

## 对比步骤

1. 先同步远端引用：`git -C $REPO fetch origin main`。失败时按平台处理，并把错误原文告诉用户：
   - macOS：换 SSH 地址直接 fetch —— `git -C $REPO fetch git@github.com:PureWhite202/my-dsh.git main`
   - Windows：公开仓库 fetch 不需要凭据；若报认证错误，先 `git config --global credential.helper manager` 再重试
2. **仓库插件**：`git -C $REPO ls-tree -d --name-only origin/main plugins/` 拿到目录清单；再逐个看 `SOURCE.md` 里的「安装来源：npm \`包名@版本\`` 读出 npm 包名。
3. **本机插件**：读 profile 的 `package.json`。名字对不上时按规则归一：去掉 `@scope/`、去掉版本号、取最后一段（`@zfdx123/dsh-superpowers` ↔ `dsh-superpowers`，`link:.../dsh-auto-archive` ↔ `dsh-auto-archive`）。
4. **技能**：`git -C $REPO ls-tree -d --name-only origin/main skills/` 对比两个本机技能目录。注意：本机技能大多是插件自动同步出来的，不等于「仓库该收录」，报告里要说明这一点，别把 40 多个全算成仓库缺的。
5. **全局指令**：`git -C $REPO show origin/main:config/AGENTS.md` 和 `~/.dsh/AGENTS.md` 比，报增删行数、第一个差异行，并附几行「- / +」示例。
6. **顺带看工作树**：`git -C $REPO status --porcelain` 和 `git -C $REPO rev-list --left-right --count origin/main...HEAD`，告诉用户有多少未提交改动、领先/落后几个提交。

## 报告怎么写

用中文，分三块，先结论后细节：

1. **仓库有、本机没有**（拉取候选）：插件、技能分开列；没有就写「无」。
2. **本机有、仓库没有**（推送候选）：同上。
3. **全局指令 AGENTS.md**：一致就写一致；不一致给行数与示例。

最后一行给结论：现在要不要动、动什么（拉取 / 推送 / 都不做）。

## 硬规矩

- 对比阶段**只读**：不 `git add`、不 `commit`、不 `push`、不 `pull`、不装/卸插件、不改 `~/.dsh` 下任何配置。
- 报告完就停下，问用户要不要拉取或推送。用户明确同意后再动手，动手前把要执行的命令逐条列出来。
- 拉取 = 云端 → 本机；推送 = 本机 → 云端。

## 拉取（云端 → 本机）

```bash
git -C $REPO fetch origin main
git -C $REPO pull --ff-only origin main
```

本机有未提交改动时不要硬拉：先 `git -C $REPO status --porcelain` 看清楚，问用户是提交、stash，还是先不拉。

## 推送（本机 → 云端）

```bash
git -C $REPO status --porcelain
git -C $REPO add <只挑要提交的路径>
git -C $REPO commit -m "<说明这次改了什么>"
git -C $REPO push origin main
```

要点：

- **不要 `git add -A`**。仓库里经常混着别的会话正在改的文件（比如 `plugins/dsh-talk-map-local/client/client.js`），先看 status、只挑这次该进的路径；用户没说要带的东西就问一句。
- 推送前确认远端没有新提交：`git -C $REPO fetch origin main` 后再看 ahead / behind。
- **先 dry-run 再真推**：`git -C $REPO push --dry-run origin main` 能提前暴露凭据问题，且不会留下任何痕迹。Windows 上尤其值得先跑这一次。
- push 被拒（non-fast-forward）时，先 fetch 再决定 rebase 还是先拉，**不要 `push --force`**。

## 仓库约定（帮你判断哪些该进仓库）

- 自制或改过的插件放 `plugins/`，整个目录进仓库；
- 没改过的上游插件只在 `plugins/<名字>/SOURCE.md` 里写来源，不放源码；
- 配置只归档 `config/AGENTS.md`（对应 `~/.dsh/AGENTS.md`），profile 的另外两个配置文件不在仓库里；
- 技能放 `skills/<技能名>/SKILL.md`，本机用软链指到 `~/.agents/skills/<技能名>`。

## 常见情况

- **macOS · SSH 报 Permission denied (publickey)**：先 `ssh -T git@github.com` 确认；再检查 `~/.ssh/config` 里 github.com 是否指向 `id_ed25519_github`；最后确认公钥已加到 GitHub 账号。
- **Windows · push 报 Authentication failed**：`git config --global --get credential.helper` 看是否配了；没配按「Windows 凭据」一节配。已配 `store` 的话，检查 `%USERPROFILE%\.git-credentials` 里那行 token 是否过期（GitHub 的 PAT 有有效期）。
- **Windows · ssh -T 报 Permission denied**：正常，这台机器没配 SSH。别动 remote，走 HTTPS。
- **fetch 正常但显示落后很多**：可能是本机换过分支或远端被重写，先看 `git log --oneline -5 origin/main` 再决定。
- **找不到仓库目录**：`git -C <任意插件目录> rev-parse --show-toplevel`，插件通常就在仓库内的 `plugins/` 下。
- **本机插件名和仓库目录名对不上**：以 `SOURCE.md` 里声明的 npm 名为准，没有 `SOURCE.md` 就按目录名。
- **AGENTS.md 差异很多行**：多半是两边各自加过内容，把差异摘要给用户，别自作主张合并。
