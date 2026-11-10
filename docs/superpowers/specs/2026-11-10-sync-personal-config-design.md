# 同步个人配置：从命令改为技能（迁移记录）

日期：2026-11-10
状态：命令方案已废弃，改为技能 `sync-config`

## 为什么改

原来的 `/sync-config` 是 `dsh-purewhite-toolkit` 里注册的斜杠命令：插件在进程内做只读扫描，把事实快照注入成一条消息交给模型，规则挂在系统提示里。

改技能的理由：

- 技能和命令共用同一个 `/` 触发（`context` 输入源 `trigger: "/"`），`/sync-config` 照样能打；
- 技能默认模型可触发，说「对比一下本机和云端」也能命中；
- 内容全是自然语言，改起来不用碰插件代码，也不用热重载；
- 技能可以随仓库走，换机器克隆仓库再链一下就能用。

## 现在是什么

- 技能：`plugins/dsh-purewhite-toolkit/skills/sync-config/SKILL.md`，随插件加载时用 `ctx.skills.register` 注册，不单独软链。
- 触发：`/sync-config`，不带参数。
- 行为：对比本机实装环境与云端 `origin/main` 的插件、技能、全局指令差异，只读汇报；拉取 / 推送按 SSH 方式写在技能正文里，执行前要人确认。

## 删掉了什么

`dsh-purewhite-toolkit` 里的 `/sync-config` 命令实现、扫描函数、系统提示片段、相关配置项和 `test/sync-smoke.mjs` 全部移除，插件回到只提供 `screenshot`。
