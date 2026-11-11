/**
 * readonly-guard 的单元测试：用假 ctx/session 验证
 *  1. 只读预设 + 首轮 → 追加 permission/preset、sandbox/mode、approval/policy；
 *  2. 非只读预设、非首轮、已是只读 → 不追加；
 *  3. 运行时上下文只在只读会话里返回说明文本；
 *  4. request_standard_mode 工具：只在只读会话可见；用户允许才解除只读，拒绝/异常都不写事件。
 */

import assert from 'node:assert/strict'
import { apply } from '../readonly-guard.js'

/** 构造一次被测运行。 */
function setup(overrides = {}) {
  const state = {
    preset: 'readonly',
    lastTurn: 0,
    mode: 'danger-full-access',
    approval: 'ask',
    ...overrides,
  }
  const handlers = new Map()
  const contexts = []
  const appended = []
  const tools = []
  const asked = []
  let answer = { answers: [{ id: 'switch-to-standard-mode', selected: ['允许切换到标准模式'] }] }
  let askError = null

  const session = {
    append(type, data) {
      appended.push([type, data])
    },
  }
  const ctx = {
    effect: (fn) => fn(),
    on: (name, handler) => {
      handlers.set(name, handler)
    },
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['tools', 'userQuestions'])
      callback({
        tools: {
          register(definition, options) {
            tools.push({ definition, options })
          },
        },
        userQuestions: {
          async ask(request) {
            asked.push(request)
            if (askError !== null) throw askError
            return answer
          },
        },
      })
    },
    logger: { warn() {} },
    systemPrompt: {
      context: (contribution) => {
        contexts.push(contribution)
        return () => {}
      },
      getContextOrder: () => 115,
    },
    sandboxPolicy: { resolve: () => ({ mode: state.mode }) },
    approval: { effectivePolicy: () => state.approval },
    agents: { turnBoundaryOf: () => ({ lastTurn: state.lastTurn }) },
    agentPresets: { presetForSession: () => state.preset },
  }
  apply(ctx, { preset: 'readonly', permissionPreset: 'read-only-mode' })
  return {
    state,
    handlers,
    contexts,
    appended,
    tools,
    asked,
    session,
    setAnswer(value) {
      answer = value
    },
    setAskError(value) {
      askError = value
    },
  }
}

async function runPreStep(handlers, session) {
  const handler = handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function', 'agent/pre-step listener must be registered')
  let nextCalled = 0
  const decision = await handler({ agent: { session } }, async () => {
    nextCalled++
    return 'decision'
  })
  assert.equal(nextCalled, 1, 'must call next()')
  return decision
}

function switchTool(tools) {
  const entry = tools.find((item) => item.definition.name === 'request_standard_mode')
  assert.ok(entry !== undefined, 'request_standard_mode tool must be registered')
  return entry
}

const tests = []

tests.push({
  name: 'pins read-only + never on the first turn of the readonly preset',
  async run() {
    const { handlers, appended, session } = setup()
    const decision = await runPreStep(handlers, session)
    assert.equal(decision, 'decision', 'must return the next decision unchanged')
    assert.deepEqual(appended, [
      ['permission/preset', { preset: 'read-only-mode' }],
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'never' }],
    ])
  },
})

tests.push({
  name: 'does nothing for another preset',
  async run() {
    const { handlers, appended, session } = setup({ preset: 'standard' })
    await runPreStep(handlers, session)
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'does nothing after the first turn',
  async run() {
    const { handlers, appended, session } = setup({ lastTurn: 3 })
    await runPreStep(handlers, session)
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'is idempotent when the session is already pinned',
  async run() {
    const { handlers, appended, session } = setup({ mode: 'read-only', approval: 'never' })
    await runPreStep(handlers, session)
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'registers one runtime context that only speaks for read-only sessions',
  async run() {
    const { contexts } = setup({ mode: 'read-only' })
    assert.equal(contexts.length, 1)
    const contribution = contexts[0]
    assert.equal(contribution.name, 'readonly:mode')
    assert.equal(contribution.order, 116)

    const text = contribution.text({ agent: { session: {} } })
    assert.ok(text.includes('read-only mode'), 'notice must name read-only mode')
    assert.ok(text.includes('request_standard_mode'), 'notice must point at the request tool')
    assert.equal(contribution.text({}), '', 'no agent context yields no text')
  },
})

tests.push({
  name: 'notice stays silent outside read-only',
  async run() {
    const { contexts, state } = setup({ mode: 'workspace-write' })
    const contribution = contexts[0]
    assert.equal(contribution.text({ agent: { session: {} } }), '')
    state.mode = 'read-only'
    assert.ok(contribution.text({ agent: { session: {} } }).length > 0)
  },
})

tests.push({
  name: 'request tool is visible in read-only sessions and for the readonly preset',
  async run() {
    const { tools, state } = setup({ mode: 'read-only', preset: 'standard' })
    const { options } = switchTool(tools)
    const agent = { session: {} }
    assert.equal(options.when({ agent }), true, 'visible while the sandbox is read-only')
    state.preset = 'readonly'
    state.mode = 'danger-full-access'
    assert.equal(options.when({ agent }), true, 'visible on the readonly preset before the first pin')
    state.preset = 'standard'
    assert.equal(options.when({ agent }), false, 'hidden otherwise')
    assert.equal(options.when({ agent: undefined }), false)
  },
})

tests.push({
  name: 'user approval switches the session to writable mode',
  async run() {
    const { tools, appended, asked, session } = setup({ mode: 'read-only' })
    const { definition } = switchTool(tools)
    const result = await definition.execute({}, { agent: { session } })
    assert.equal(result.switched, true)
    assert.equal(asked.length, 1, 'must ask the user once')
    assert.equal(asked[0].questions[0].id, 'switch-to-standard-mode')
    assert.deepEqual(asked[0].questions[0].options.map((option) => option.label), [
      '允许切换到标准模式',
      '保持只读',
    ])
    assert.deepEqual(appended, [
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
  },
})

tests.push({
  name: 'a refusal keeps the session read-only and writes nothing',
  async run() {
    const { tools, appended, session, setAnswer } = setup({ mode: 'read-only' })
    setAnswer({ answers: [{ id: 'switch-to-standard-mode', selected: ['保持只读'] }] })
    const result = await switchTool(tools).definition.execute({}, { agent: { session } })
    assert.equal(result.switched, false)
    assert.ok(result.message.includes('保持只读'))
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'a skipped answer keeps the session read-only',
  async run() {
    const { tools, appended, session, setAnswer } = setup({ mode: 'read-only' })
    setAnswer({ answers: [{ id: 'switch-to-standard-mode', selected: [] }] })
    const result = await switchTool(tools).definition.execute({}, { agent: { session } })
    assert.equal(result.switched, false)
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'does not ask when the session is already writable',
  async run() {
    const { tools, appended, asked, session } = setup({ mode: 'danger-full-access' })
    const result = await switchTool(tools).definition.execute({}, { agent: { session } })
    assert.equal(result.switched, false)
    assert.equal(asked.length, 0)
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'a failed confirmation keeps the session read-only',
  async run() {
    const { tools, appended, session, setAskError } = setup({ mode: 'read-only' })
    setAskError(new Error('no user-questions answerer accepted the request'))
    const result = await switchTool(tools).definition.execute({}, { agent: { session } })
    assert.equal(result.switched, false)
    assert.ok(result.message.includes('继续只读'))
    assert.deepEqual(appended, [])
  },
})

let failed = 0
for (const test of tests) {
  try {
    await test.run()
    console.log('ok   -', test.name)
  } catch (error) {
    failed++
    console.error('FAIL -', test.name)
    console.error(error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
