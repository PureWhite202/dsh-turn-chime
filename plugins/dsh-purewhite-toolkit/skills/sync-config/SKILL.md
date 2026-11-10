---
name: sync-config
description: "对比本机 DSH 实装环境与云端仓库 PureWhite202/my-dsh 的差异（插件、技能、全局指令），把两边谁多谁少说清楚；需要时再按 SSH 方式拉取或推送。用户输入 /sync-config，或说「对比本机和云端」「同步个人配置」「仓库里是不是少了什么」时使用。"
---

# 同步个人配置（sync-config）

## 这个技能解决什么

`~/.dsh/my-dsh` 是本机 DSH 环境的存档仓库，GitHub 上是 `PureWhite202/my-dsh`。时间一长，本机装的东西和仓库里存的东西会两头不一致：仓库里有的插件本机没装、本机新装的插件没进仓库、全局指令各有各的版本。

这个技能的工作只有一件事：**把本机实装环境和云端仓库摊开对比，报告差异，然后停下来**。不带参数、不做修改、不预设方向。

## 仓库与连接（SSH）

- 本地克隆：`~/.dsh/my-dsh`
- 远端：`git@github.com:PureWhite202/my-dsh.git`（SSH），默认分支 `main`
- SSH 私钥：`~/.ssh/id_ed25519_github`，公钥是同目录下的 `id_ed25519_github.pub`
- 连通性自检：跑 `ssh -T git@github.com`，正常会回 `Hi PureWhite202! You've successfully authenticated, but GitHub does not provide shell access.`

如果 `origin` 的 fetch 地址还是 https（`git -C ~/.dsh/my-dsh remote -v` 可以看），拉取推送要统一走 SSH 时先换地址：

```bash
git -C ~/.dsh/my-dsh remote set-url origin git@github.com:PureWhite202/my-dsh.git
```

换机器时如果 SSH 不通：`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -C "dsh"` 生成密钥，把 `.pub` 内容加到 GitHub → Settings → SSH and GPG keys，再用 `ssh -T git@github.com` 验证。

## 本机 = 实装环境

- **插件**：`~/.dsh/profiles/<当前 profile>/package.json` 里的 `dependencies`（这台机器上是 `desktop`），排除 `@deepseek-ai/` 开头的官方包；同一个文件的 `dsh.profile.bundles` 是 bundle 的启用顺序，可以参考对照。
- **技能**：`~/.agents/skills` 与 `~/.dsh/skills` 下的目录名（两边取并集）。
- **全局指令**：`~/.dsh/AGENTS.md`。

## 云端 = 远端 origin/main

不要把本地工作树当成「云端」——工作树里有别人（或你自己）没提交的改动。正确做法是先 `git fetch`，再用 `git ls-tree` / `git show` 读 `origin/main` 的内容。

## 对比步骤

1. 先同步远端引用：`git -C ~/.dsh/my-dsh fetch origin main`。失败就换 SSH 地址直接 fetch（`git -C ~/.dsh/my-dsh fetch git@github.com:PureWhite202/my-dsh.git main`），并把错误原文告诉用户。
2. **仓库插件**：`git -C ~/.dsh/my-dsh ls-tree -d --name-only origin/main plugins/` 拿到目录清单；再逐个看 `SOURCE.md` 里的「安装来源：npm \`包名@版本\`` 读出 npm 包名。
3. **本机插件**：读 profile 的 `package.json`。名字对不上时按规则归一：去掉 `@scope/`、去掉版本号、取最后一段（`@zfdx123/dsh-superpowers` ↔ `dsh-superpowers`，`link:.../dsh-auto-archive` ↔ `dsh-auto-archive`）。
4. **技能**：`git -C ~/.dsh/my-dsh ls-tree -d --name-only origin/main skills/` 对比两个本机技能目录。注意：本机技能大多是插件自动同步出来的，不等于「仓库该收录」，报告里要说明这一点，别把 40 多个全算成仓库缺的。
5. **全局指令**：`git -C ~/.dsh/my-dsh show origin/main:config/AGENTS.md` 和 `~/.dsh/AGENTS.md` 比，报增删行数、第一个差异行，并附几行「- / +」示例。
6. **顺带看工作树**：`git -C ~/.dsh/my-dsh status --porcelain` 和 `git -C ~/.dsh/my-dsh rev-list --left-right --count origin/main...HEAD`，告诉用户有多少未提交改动、领先/落后几个提交。

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
git -C ~/.dsh/my-dsh fetch origin main
git -C ~/.dsh/my-dsh pull --ff-only origin main
```

本机有未提交改动时不要硬拉：先 `git -C ~/.dsh/my-dsh status --porcelain` 看清楚，问用户是提交、stash，还是先不拉。

## 推送（本机 → 云端）

```bash
git -C ~/.dsh/my-dsh status --porcelain
git -C ~/.dsh/my-dsh add <只挑要提交的路径>
git -C ~/.dsh/my-dsh commit -m "<说明这次改了什么>"
git -C ~/.dsh/my-dsh push origin main
```

要点：

- **不要 `git add -A`**。仓库里经常混着别的会话正在改的文件（比如 `plugins/dsh-talk-map-local/client/client.js`），先看 status、只挑这次该进的路径；用户没说要带的东西就问一句。
- 推送前确认远端没有新提交：`git -C ~/.dsh/my-dsh fetch origin main` 后再看 ahead / behind。
- push 被拒（non-fast-forward）时，先 fetch 再决定 rebase 还是先拉，不要 `push --force`。

## 仓库约定（帮你判断哪些该进仓库）

- 自制或改过的插件放 `plugins/`，整个目录进仓库；
- 没改过的上游插件只在 `plugins/<名字>/SOURCE.md` 里写来源，不放源码；
- 配置只归档 `config/AGENTS.md`（对应 `~/.dsh/AGENTS.md`），profile 的另外两个配置文件不在仓库里；
- 技能放 `skills/<技能名>/SKILL.md`，本机用软链指到 `~/.agents/skills/<技能名>`。

## 常见情况

- **SSH 报 Permission denied (publickey)**：先用 `ssh -T git@github.com` 确认；再检查 `~/.ssh/config` 里 github.com 是否指向 `id_ed25519_github`；最后确认公钥已加到 GitHub 账号。
- **fetch 正常但显示落后很多**：可能是本机换过分支或远端被重写，先看 `git log --oneline -5 origin/main` 再决定。
- **本机插件名和仓库目录名对不上**：以 `SOURCE.md` 里声明的 npm 名为准，没有 `SOURCE.md` 就按目录名。
- **AGENTS.md 差异很多行**：多半是两边各自加过内容，把差异摘要给用户，别自作主张合并。
