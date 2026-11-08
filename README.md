# 自用 DSH 插件与配置

本机（Windows）DSH 环境的存档，Mac 上照单取用。

约定：自制或改过的进 `plugins/`、`skills/` 打包；没改过的只建目录放 `SOURCE.md` 指向上游。

## 插件

| 目录 | 做什么 | 来源 |
| --- | --- | --- |
| [dsh-turn-chime](plugins/dsh-turn-chime/) | 一轮结束、模型反问时各响一声 | 自制 |
| [dsh-auto-archive](plugins/dsh-auto-archive/) | 启动时归档闲置会话 | 自制 |
| [dsh-ops](plugins/dsh-ops/SOURCE.md) | 原生文件与 Bash 工具层 | npm 0.5.0 |
| [dsh-superpowers](plugins/dsh-superpowers/SOURCE.md) | 技能与工作流 | npm 1.0.16 |
| [dsh-memory-evolve](plugins/dsh-memory-evolve/SOURCE.md) | 记忆、待办 | github |
| [dsh-talk-map-local](plugins/dsh-talk-map-local/) | 会话地图，本地大改版 | 基于 github:Tasihi89/dsh-talk-map |

## 技能

| 目录 | 装到 | 来源 |
| --- | --- | --- |
| [humanizer-zh](skills/humanizer-zh/) | `~/.dsh/skills` | 本地，无上游记录 |
| [codex-cli-calling](skills/codex-cli-calling/) | `~/.agents/skills` | 本机生成 |
| [grok-cli-calling](skills/grok-cli-calling/) | `~/.agents/skills` | 本机生成 |
| [hermes-cli-calling](skills/hermes-cli-calling/) | `~/.agents/skills` | 本机生成 |
| [kimi-cli-calling](skills/kimi-cli-calling/) | `~/.agents/skills` | 本机生成 |
| [memory-consolidate](skills/memory-consolidate/) | `~/.agents/skills` | 本机生成 |
| [office-lite](skills/office-lite/) | `~/.agents/skills` | 本机自带 |
| [video-shotcraft](skills/video-shotcraft/SOURCE.md) | `~/.dsh/skills` | 上游克隆，未改 |

## 配置

| 文件 | 对应 |
| --- | --- |
| [config/AGENTS.md](config/AGENTS.md) | `~/.dsh/AGENTS.md` |
| [config/cordis.patch.yml](config/cordis.patch.yml) | profile 的 `cordis.patch.yml` |
| [config/plugins.json](config/plugins.json) | profile 已启用的 bundles 与依赖清单 |
