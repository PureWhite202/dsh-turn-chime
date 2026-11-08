# dsh-auto-archive

DSH 插件：**每次启动时，把默认工作区里“超过设定时间没聊过、且没有置顶”的对话自动归档。**

只做这一件事：Host 侧插件，无 UI、无第三方依赖、不改任何现有代码。

## 归档规则

每次 DSH 启动后延迟 `startupDelayMs`（默认 3 秒，等界面恢复上次会话）执行一次：

```
默认工作区会话
  ∩ 未置顶
  ∩ 未归档
  ∩ 当前没有 live agent / running
  ∩ 非子代理会话
  ∩ 最后活动时间 > minAgeHours（默认 24 小时）
  → 归档
```

- **“最后活动时间”的口径与侧边栏一致**：取 `SessionSummary.updatedAt`，即
  `max(创建时间, 最后一条真实用户消息时间)`（DSH 的 `sessionListMetadata` 投影）。
  所以“创建很久但昨天还在聊”的会话不会被误归档。
- **置顶永不归档**。归档与置顶在 DSH 里互斥，归档会顺带清掉置顶，这里直接跳过置顶会话。
- **正在用的会话跳过**：有 live agent、`running` 或正在被接入的会话不动；即使判断失误，
  `archiveSession` 对活动中会话会抛 `WorkspaceActiveSessionError`，插件捕获后跳过，不打断任务。
- **子代理会话跳过**，避免把子代理的临时对话归档掉。
- **拿不到最后活动时间的会话默认跳过**：投影缓存缺失时 `updatedAt` 只剩创建时间，
  不能代表“最后聊过”，偏保守不归档（`archiveUnverified: true` 可放开）。
- **空对话**（创建后一轮都没聊过）默认也归档，`archiveBlank: false` 可关闭。

归档 = 从工作区分组里隐藏，**不删除会话日志**，可在侧边栏“归档”里恢复。

## 配置

全部字段可省略，写在 `cordis.patch.yml` 的 `config` 里：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 临时停用 |
| `minAgeHours` | `24` | 超过多少小时没活动就归档 |
| `startupDelayMs` | `8000` | 启动后延迟多久扫描（给界面恢复上次会话留时间） |
| `archiveBlank` | `true` | 空对话是否归档 |
| `archiveUnverified` | `false` | 无投影缓存（无法确认最后活动时间）的会话是否也归档 |
| `dryRun` | `false` | `true` 时只写报告、不落归档 |
| `workspacePath` | 默认工作区 | 指定要处理的工作区目录（绝对路径） |
| `reportPath` | `$DSH_HOME/cache/dsh-auto-archive/last-run.json` | 运行报告路径；`false` 关闭 |

## 运行报告

桌面版的普通日志不进文件，所以每次扫描都会写一份 JSON 报告（默认在
`%USERPROFILE%\.dsh\cache\dsh-auto-archive\last-run.json`）：

```json
{
  "startedAt": "2026-11-08T00:40:00.000Z",
  "thresholdHours": 24,
  "dryRun": false,
  "workspace": { "id": "1129b56f-...", "path": "D:\\Document\\deepseek-harness\\default-workspace", "title": "default-workspace" },
  "candidates": [{ "sessionId": "session-...", "activeAt": "...", "ageHours": 55.2, "blank": false }],
  "archived": ["session-..."],
  "skipped": { "pinned": 1, "archived": 80, "running": 2, "blank": 0, "unverified": 0, "missing": 0,
               "activeDuringArchive": { "length": 0, "ids": [] }, "disappeared": 0 },
  "failed": [],
  "error": null
}
```

## 验证

1. 把 `dryRun: true` 写进 `cordis.patch.yml`，重启 DSH；
2. 看报告里的 `candidates`，与侧边栏里超过一天没动的未置顶会话核对；
3. 改回 `dryRun: false`，再重启，报告 `archived` 应等于上一轮 `candidates`，
   且 `workspace.json` 的 `archivedSessionIds` 增加这些 id、`pinnedSessionIds` 不变。

## 注意

- 只在 **Host 启动时**扫描一次（符合“每次打开 DSH”）；DSH 一直开着不会周期执行。
- 只处理 **默认工作区**，其他工作区不碰。默认工作区通过
  `workspaceController.initializeDefault()` 取回 DSH 登记的默认身份，取不到时按
  `.../deepseek-harness/default-workspace` 路径兜底。
- 归档是可逆操作：侧边栏归档区 → 恢复。
