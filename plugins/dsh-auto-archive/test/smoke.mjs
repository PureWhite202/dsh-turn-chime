/**
 * dsh-auto-archive 冒烟测试：不连真实宿主，用假 ctx 验证筛选规则、dryRun、
 * 报告写入和归档调用。运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../index.js'

const HOUR = 60 * 60 * 1000
const now = Date.now()

/** 构造一条会话摘要；默认“很老、非空、非运行”。 */
function summary(sessionId, overrides = {}) {
  return {
    sessionId,
    updatedAt: now - 30 * HOUR,
    running: false,
    agentAvailable: false,
    blank: false,
    projections: { kind: 'cached', asOfSeq: 1, values: {} },
    ...overrides,
  }
}

const workspacePath = 'D:\\tmp\\deepseek-harness\\default-workspace'

/** 假的工作区实体。 */
function makeWorkspace(sessionIds) {
  return {
    id: 'ws-default',
    path: workspacePath,
    title: 'default-workspace',
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    sessionIds,
  }
}

/**
 * 跑一轮插件。
 * @returns 归档调用记录与报告对象。
 */
async function run(scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-archive-'))
  const reportPath = join(dir, 'last-run.json')
  const workspace = makeWorkspace(scenario.sessionIds)
  const archivedCalls = []
  const liveAgents = new Set(scenario.liveAgents ?? [])

  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (execute) => execute(),
    get: () => undefined,
    workspaceRegistry: {
      pinnedSessionIds: scenario.pinned ?? [],
      archivedSessionIds: scenario.archived ?? [],
      list: () => [workspace],
      get: (id) => (id === workspace.id ? workspace : undefined),
      resolveByPath: async () => workspace,
      archiveSession: async (sessionId) => {
        archivedCalls.push(sessionId)
      },
    },
    sessionController: {
      list: async () => ({ items: scenario.summaries }),
    },
    agents: {
      get: (id) => (liveAgents.has(id) ? { id } : undefined),
    },
    sessions: {
      get: () => undefined,
    },
  }

  apply(ctx, {
    minAgeHours: 24,
    startupDelayMs: 1,
    dryRun: scenario.dryRun === true,
    reportPath,
    ...scenario.config,
  })

  // 等 1ms 定时器 + 异步落盘。
  let report
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'))
      break
    } catch {}
  }
  await rm(dir, { recursive: true, force: true })
  assert.ok(report, '报告文件应当被写出')
  return { archivedCalls, report }
}

// 1) 规则：老的归档；新的、置顶的、已归档的、运行中的、子代理、无缓存都跳过。
{
  const ids = [
    'session-old',
    'session-blank',
    'session-new',
    'session-pinned',
    'session-archived',
    'session-running',
    'session-subagent',
    'session-unverified',
  ]
  const summaries = [
    summary('session-old'),
    summary('session-blank', { updatedAt: now - 90 * HOUR, blank: true }),
    summary('session-new', { updatedAt: now - 2 * HOUR }),
    summary('session-pinned', { updatedAt: now - 60 * HOUR }),
    summary('session-archived', { updatedAt: now - 60 * HOUR }),
    summary('session-running', { updatedAt: now - 90 * HOUR, running: true }),
    summary('session-subagent', { updatedAt: now - 90 * HOUR, origin: 'subagent' }),
    summary('session-unverified', { updatedAt: now - 90 * HOUR, projections: undefined }),
  ]

  const { archivedCalls, report } = await run({
    sessionIds: ids,
    summaries,
    pinned: ['session-pinned'],
    archived: ['session-archived'],
  })

  assert.deepEqual(archivedCalls.sort(), ['session-blank', 'session-old'], '只归档老的非置顶会话')
  assert.deepEqual(
    report.candidates.map((candidate) => candidate.sessionId),
    ['session-blank', 'session-old'],
    '候选按最旧优先排序',
  )
  assert.equal(report.dryRun, false)
  assert.equal(report.skipped.pinned, 1)
  assert.equal(report.skipped.archived, 1)
  assert.equal(report.skipped.running, 2)
  assert.equal(report.skipped.unverified, 1)
  assert.equal(report.skipped.blank, 0)
  assert.deepEqual(report.failed, [])
  console.log('ok 1: 筛选与归档调用')
}

// 2) dryRun：只写报告，不调用 archiveSession。
{
  const { archivedCalls, report } = await run({
    sessionIds: ['session-old'],
    summaries: [summary('session-old', { updatedAt: now - 30 * HOUR })],
    dryRun: true,
  })
  assert.deepEqual(archivedCalls, [], 'dryRun 不应归档')
  assert.deepEqual(report.archived, ['session-old'], 'dryRun 报告列出“将归档”')
  console.log('ok 2: dryRun')
}

// 3) archiveBlank=false：空对话不归档。
{
  const { archivedCalls, report } = await run({
    sessionIds: ['session-blank'],
    summaries: [summary('session-blank', { updatedAt: now - 90 * HOUR, blank: true })],
    config: { archiveBlank: false },
  })
  assert.deepEqual(archivedCalls, [], 'archiveBlank=false 时空对话不归档')
  assert.equal(report.skipped.blank, 1)
  console.log('ok 3: archiveBlank=false')
}

// 4) live agent：即便摘要没标 running，有 live agent 也不归档。
{
  const { archivedCalls } = await run({
    sessionIds: ['session-live'],
    summaries: [summary('session-live', { updatedAt: now - 90 * HOUR })],
    liveAgents: ['session-live'],
  })
  assert.deepEqual(archivedCalls, [], '有 live agent 的会话不归档')
  console.log('ok 4: live agent 保护')
}

// 5) 导出的元数据符合 bundle 约定。
{
  assert.equal(name, 'dsh-auto-archive')
  assert.ok(inject.includes('workspaceRegistry'))
  assert.ok(inject.includes('sessionController'))
  console.log('ok 5: 元数据')
}

console.log('all smoke tests passed')
