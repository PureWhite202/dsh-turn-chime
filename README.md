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

仓库内暂无技能条目。`humanizer-zh` 的历程：2026-11-09 从技能移到全局指令（正文并入 `config/AGENTS.md` 与 `~/.dsh/AGENTS.md`），2026-11-10 11:27 又从全局指令整段移除（本机备份 `~/.dsh/backups/AGENTS.md.before-remove-humanizer-20261110`）。需要原文时：`git show 28802bc:config/AGENTS.md` 取合并后的正文，`git checkout c8b7fa5 -- skills/humanizer-zh` 取最初的技能目录。

codex/grok/hermes/kimi-cli-calling 和 memory-consolidate 由 `dsh-memory-evolve` 启动时自动同步到 `~/.agents/skills`，不在仓库存储。

## 配置

| 文件 | 对应 |
| --- | --- |
| [config/AGENTS.md](config/AGENTS.md) | `~/.dsh/AGENTS.md` |
| [config/cordis.patch.yml](config/cordis.patch.yml) | profile 的 `cordis.patch.yml` |
| [config/plugins.json](config/plugins.json) | profile 已启用的 bundles 与依赖清单 |
