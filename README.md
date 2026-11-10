# 自用 DSH 插件与配置

本机（Windows）DSH 环境的存档，Mac 上照单取用。

约定：自制或改过的进 `plugins/`、`skills/` 打包；没改过的只建目录放 `SOURCE.md` 指向上游。

## 插件

| 目录 | 做什么 | 来源 |
| --- | --- | --- |
| [dsh-turn-chime](plugins/dsh-turn-chime/) | 一轮结束、模型反问时各响一声 | 自制 |
| [dsh-auto-archive](plugins/dsh-auto-archive/) | 启动时归档闲置会话 | 自制 |
| [dsh-ops](plugins/dsh-ops/SOURCE.md) | 原生文件与 Bash 工具层 | npm 0.5.2 |
| [dsh-superpowers](plugins/dsh-superpowers/SOURCE.md) | 技能与工作流 | npm 1.0.16 |
| [dsh-memory-evolve](plugins/dsh-memory-evolve/SOURCE.md) | 记忆、待办 | github |
| [dsh-talk-map-local](plugins/dsh-talk-map-local/) | 会话地图，本地大改版 | 基于 github:Tasihi89/dsh-talk-map |
| [dsh-purewhite-toolkit](plugins/dsh-purewhite-toolkit/) | 自用工具集：截图（整屏/窗口/区域，直接返回图片） | 自制 |
| [dshmarket](plugins/dshmarket/SOURCE.md) | 插件市场：浏览、搜索、一键安装社区插件 | npm 1.73.17 |
| [ds-harness-remote](plugins/ds-harness-remote/SOURCE.md) | P2P 端到端加密远程访问 DSH 工作区 | npm 0.6.4 |

## 技能

| 目录 | 做什么 | 触发 |
| --- | --- | --- |
| [plugins/dsh-purewhite-toolkit/skills/sync-config](plugins/dsh-purewhite-toolkit/skills/sync-config/SKILL.md) | 对比本机实装环境与云端仓库的插件、技能、全局指令差异；拉取/推送方式写在正文里 | `/sync-config`，或说「对比本机和云端」「同步个人配置」 |

这个技能随 `dsh-purewhite-toolkit` 插件加载时注册（`ctx.skills.register`），不需要单独软链。

`humanizer-zh` 的历程：2026-11-09 从技能移到全局指令（正文并入 `config/AGENTS.md` 与 `~/.dsh/AGENTS.md`），2026-11-10 11:27 又从全局指令整段移除（本机备份 `~/.dsh/backups/AGENTS.md.before-remove-humanizer-20261110`）。需要原文时：`git show 28802bc:config/AGENTS.md` 取合并后的正文，`git checkout c8b7fa5 -- skills/humanizer-zh` 取最初的技能目录。

codex/grok/hermes/kimi-cli-calling 和 memory-consolidate 由 `dsh-memory-evolve` 启动时自动同步到 `~/.agents/skills`，不在仓库存储。

## 配置

只存全局提示词。profile 的 `cordis.patch.yml` 与插件清单（原 `config/plugins.json`）不再入库：它们含本机路径与机器偏好，还会被插件管理器、设置页写回，各机各自维护。

| 文件 | 对应 |
| --- | --- |
| [config/AGENTS.md](config/AGENTS.md) | `~/.dsh/AGENTS.md` |
