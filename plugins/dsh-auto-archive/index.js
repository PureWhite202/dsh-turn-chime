/**
 * dsh-auto-archive — DSH 启动时自动归档“默认工作区里老掉”的对话。
 *
 * 规则（每次 Host 启动后延迟几秒执行一次）：
 *   默认工作区的会话 ∩ 未置顶 ∩ 未归档 ∩ 当前没有 live agent ∩ 最后活动时间超过阈值
 *   → 调用 `workspaceRegistry.archiveSession()` 归档。
 *
 * “最后活动时间”用的是 `SessionSummary.updatedAt`，即 DSH 侧边栏排序所用的
 * `max(header.createdAt, 最后一条真实用户消息时间)`（见 dsh-api-session-controller
 * 的 `sessionListMetadata` 投影）。因此插件判断“超过一天”和用户在列表里看到的
 * 时间口径一致，不会把“创建很久但昨天还在聊”的会话误归档。
 *
 * 安全边界：
 *   - 置顶会话永不归档（置顶与归档本来就互斥，归档还会顺带丢置顶，这里直接跳过）；
 *   - 已有 live agent / running 的会话跳过，避免归档正在用的对话；
 *   - 子代理会话（origin === 'subagent'）跳过；
 *   - 拿不到最后活动时间（投影缓存缺失）的会话默认跳过，可用 archiveUnverified 打开；
 *   - 归档只是把会话从工作区分组里隐藏，可在侧边栏“归档”里恢复，不删除日志；
 *   - archiveSession 自己不传 stopActivity：真有活动会抛 WorkspaceActiveSessionError，
 *     这里捕获后跳过，绝不打断正在跑的任务。
 *
 * 运行报告写到 $DSH_HOME/cache/dsh-auto-archive/last-run.json（可用 reportPath 覆盖或关闭），
 * 因为桌面版正常日志不进文件，报告是唯一可事后核对的证据。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名，与 `cordis.patch.yml` 的 `name` 一致。 */
export const name = 'dsh-auto-archive'

/** 依赖的宿主服务；Cordis 会等这些服务初始化完成后才执行 apply。 */
export const inject = ['agents', 'sessionController', 'sessions', 'workspaceRegistry']

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_MIN_AGE_HOURS = 24
/** 等界面恢复上次会话再扫描；太早会误伤“用户正打算继续”的老对话。 */
const DEFAULT_STARTUP_DELAY_MS = 8000
/** 列会话的超时：本地 SQLite/缓存读取，正常几秒内完成。 */
const LIST_TIMEOUT_MS = 120_000

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 见 `cordis.patch.yml`；全部字段可选。
 */
export function apply(ctx, config = {}) {
  const options = resolveConfig(config)
  if (!options.enabled) {
    ctx.logger.info('[auto-archive] 已通过 config.enabled=false 停用，本次不扫描')
    return
  }

  const timer = setTimeout(() => {
    void runOnce(ctx, options)
  }, options.startupDelayMs)
  // 不因为这个定时器拖着进程退出。
  timer.unref?.()

  ctx.effect(() => () => clearTimeout(timer), 'auto-archive.startup-timer')
}

/**
 * 执行一次扫描；任何异常都收敛成日志 + 报告，不影响宿主。
 * @param ctx Cordis 上下文。
 * @param options 规范化后的配置。
 */
async function runOnce(ctx, options) {
  const startedAt = Date.now()
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    thresholdHours: options.minAgeHours,
    dryRun: options.dryRun,
    workspace: null,
    candidates: [],
    archived: [],
    skipped: null,
    failed: [],
    error: null,
  }

  try {
    const signal = AbortSignal.timeout(LIST_TIMEOUT_MS)
    const workspace = await resolveDefaultWorkspace(ctx, options, signal)
    report.workspace = { id: String(workspace.id), path: workspace.path, title: workspace.title }

    const list = await ctx.sessionController.list({}, signal)
    const summaries = Array.isArray(list?.items) ? list.items : []
    const plan = planArchives(ctx, workspace, summaries, options, startedAt)
    report.candidates = plan.candidates.map((candidate) => ({
      sessionId: candidate.id,
      activeAt: new Date(candidate.activeAt).toISOString(),
      ageHours: candidate.ageHours,
      blank: candidate.blank,
    }))
    report.skipped = plan.skipped

    for (const candidate of plan.candidates) {
      if (options.dryRun) {
        report.archived.push(candidate.id)
        continue
      }
      try {
        await ctx.workspaceRegistry.archiveSession(candidate.id)
        report.archived.push(candidate.id)
      } catch (error) {
        if (isNamedError(error, 'WorkspaceActiveSessionError')) {
          report.skipped.activeDuringArchive.length += 1
          report.skipped.activeDuringArchive.ids.push(candidate.id)
        } else if (isNamedError(error, 'WorkspaceUnknownSessionError')) {
          report.skipped.disappeared += 1
        } else {
          report.failed.push({ sessionId: candidate.id, error: errorMessage(error) })
        }
      }
    }

    const action = options.dryRun ? '将归档' : '已归档'
    ctx.logger.info(
      `[auto-archive] 工作区「${workspace.title}」：候选 ${plan.candidates.length}，${action} ${report.archived.length}，` +
        `跳过 置顶${plan.skipped.pinned}/已归档${plan.skipped.archived}/运行中${plan.skipped.running}/空对话${plan.skipped.blank}/无缓存${plan.skipped.unverified}，失败 ${report.failed.length}`,
    )
  } catch (error) {
    report.error = errorMessage(error)
    ctx.logger.warn(`[auto-archive] 本次扫描失败：${report.error}`)
  } finally {
    report.finishedAt = new Date().toISOString()
    await writeReport(ctx, options, report)
  }
}

/**
 * 解析默认工作区：优先走工作区控制器登记的 defaultWorkspaceId，
 * 其次按 `.../deepseek-harness/default-workspace` 路径兜底。
 * @param ctx Cordis 上下文。
 * @param options 规范化后的配置。
 * @param signal 超时/取消信号。
 * @returns 默认工作区实体。
 */
async function resolveDefaultWorkspace(ctx, options, signal) {
  if (options.workspacePath !== undefined) {
    const workspace = await ctx.workspaceRegistry.resolveByPath(options.workspacePath)
    if (workspace === undefined) throw new Error(`没有工作区登记在 ${options.workspacePath}`)
    return workspace
  }

  const controller = ctx.get('workspaceController')
  if (controller !== undefined) {
    try {
      const value = await controller.initializeDefault(signal)
      const workspaceId = value?.workspace?.workspaceId
      if (workspaceId !== undefined) {
        const workspace = ctx.workspaceRegistry.get(workspaceId)
        if (workspace !== undefined) return workspace
      }
    } catch (error) {
      ctx.logger.warn(`[auto-archive] 读取默认工作区标识失败，改用路径匹配：${errorMessage(error)}`)
    }
  }

  const fallback = ctx.workspaceRegistry.list().find((workspace) => looksLikeDefaultWorkspacePath(workspace.path))
  if (fallback !== undefined) return fallback
  throw new Error('找不到默认工作区（default-workspace），可在 config.workspacePath 指定')
}

/**
 * 计算本次要归档的会话集合。
 * @param ctx Cordis 上下文。
 * @param workspace 默认工作区实体。
 * @param summaries `sessionController.list()` 返回的会话摘要。
 * @param options 规范化后的配置。
 * @param now 本次扫描的基准时间（毫秒）。
 * @returns 候选列表与跳过统计。
 */
function planArchives(ctx, workspace, summaries, options, now) {
  const pinned = new Set(ctx.workspaceRegistry.pinnedSessionIds.map(String))
  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String))
  const byId = new Map(summaries.map((summary) => [String(summary.sessionId), summary]))
  const minAgeMs = options.minAgeHours * HOUR_MS

  const skipped = {
    pinned: 0,
    archived: 0,
    running: 0,
    blank: 0,
    unverified: 0,
    missing: 0,
    activeDuringArchive: { length: 0, ids: [] },
    disappeared: 0,
  }
  const candidates = []

  for (const rawId of workspace.sessionIds) {
    const id = String(rawId)

    if (pinned.has(id)) {
      skipped.pinned += 1
      continue
    }
    if (archived.has(id)) {
      skipped.archived += 1
      continue
    }

    const summary = byId.get(id)
    if (summary === undefined) {
      skipped.missing += 1
      continue
    }

    // 正在使用/正在跑的会话一律不碰。
    if (summary.running === true || summary.agentAvailable === true) {
      skipped.running += 1
      continue
    }
    if (ctx.agents.get(id) !== undefined || ctx.sessions.get(id) !== undefined) {
      skipped.running += 1
      continue
    }
    if (summary.origin === 'subagent') {
      skipped.running += 1
      continue
    }

    const blank = summary.blank === true
    if (blank && !options.archiveBlank) {
      skipped.blank += 1
      continue
    }

    // 没有投影缓存时 updatedAt 只是 createdAt，不能当作最后活动时间。
    const verified = summary.projections !== undefined
    if (!verified && !options.archiveUnverified) {
      skipped.unverified += 1
      continue
    }

    const activeAt = Number(summary.updatedAt)
    if (!Number.isSafeInteger(activeAt) || activeAt <= 0) {
      skipped.unverified += 1
      continue
    }

    const ageMs = now - activeAt
    if (ageMs <= minAgeMs) continue

    candidates.push({
      id,
      activeAt,
      ageHours: Math.round((ageMs / HOUR_MS) * 10) / 10,
      blank,
    })
  }

  // 越旧的越先归档，报告里读起来也更直观。
  candidates.sort((left, right) => left.activeAt - right.activeAt)
  return { candidates, skipped }
}

/**
 * 写运行报告；失败只告警，不影响归档结果。
 * @param ctx Cordis 上下文。
 * @param options 规范化后的配置。
 * @param report 本次扫描报告。
 */
async function writeReport(ctx, options, report) {
  if (options.reportPath === undefined) return
  try {
    await mkdir(dirname(options.reportPath), { recursive: true })
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch (error) {
    ctx.logger.warn(`[auto-archive] 写报告 ${options.reportPath} 失败：${errorMessage(error)}`)
  }
}

/**
 * 规范化配置，非法值回退默认值而不是让插件挂掉。
 * @param raw 宿主传入的原始 config。
 * @returns 规范化后的配置。
 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: input.enabled !== false,
    minAgeHours: nonNegativeNumber(input.minAgeHours, DEFAULT_MIN_AGE_HOURS),
    startupDelayMs: nonNegativeNumber(input.startupDelayMs, DEFAULT_STARTUP_DELAY_MS),
    archiveBlank: input.archiveBlank !== false,
    archiveUnverified: input.archiveUnverified === true,
    dryRun: input.dryRun === true,
    workspacePath: nonEmptyString(input.workspacePath),
    reportPath: resolveReportPath(input.reportPath),
  }
}

/**
 * 运行报告路径：config.reportPath 显式指定时优先；显式 false 关闭；
 * 否则落在 `$DSH_HOME/cache/dsh-auto-archive/last-run.json`。
 * @param value 原始配置值。
 * @returns 报告绝对路径，或 undefined 表示不写。
 */
function resolveReportPath(value) {
  if (value === false || value === null) return undefined
  const explicit = nonEmptyString(value)
  if (explicit !== undefined) return explicit
  // Host 进程自身不一定有 DSH_HOME（那是给子进程用的），退回 DSH 的默认家目录。
  const home = nonEmptyString(process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-auto-archive', 'last-run.json')
}

/**
 * @param path 工作区路径。
 * @returns 是否是首次使用的默认工作区目录。
 */
function looksLikeDefaultWorkspacePath(path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized.endsWith('/deepseek-harness/default-workspace')
}

/**
 * @param value 候选值。
 * @param fallback 默认值。
 * @returns 非负有限数字，否则默认值。
 */
function nonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * @param value 候选值。
 * @returns 去空白后的非空字符串，否则 undefined。
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * @param error 捕获到的错误。
 * @param name 期望的错误类名。
 * @returns 是否是该名字的错误（跨模块副本时 instanceof 不可靠，按 name 判断）。
 */
function isNamedError(error, name) {
  return error !== null && typeof error === 'object' && error.name === name
}

/**
 * @param error 捕获到的错误。
 * @returns 可读的错误描述。
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
