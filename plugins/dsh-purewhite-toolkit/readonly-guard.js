/**
 * readonly-guard — 「只读模式」Agent 预设的执行守卫。
 *
 * 选了这个预设的会话，从第一轮开始被钉成：
 *   - sandbox = read-only：dsh-fs-sandbox 与 bash/pwsh 沙箱拒绝一切写入、删除、移动；
 *   - approval = never：模型申请升权时直接拒绝，不弹审批。
 * 同时向运行时上下文补一句「你现在处于只读模式」，抵消内置 sandbox 策略行里
 * 「先试试、被拒再申请升权」的措辞。
 *
 * 另外提供一个受控出口：模型可以调用 request_standard_mode 发起「切换到标准模式」的
 * 申请，但必须经由 ctx.userQuestions 走一次阻塞式人工确认；用户选择允许后才写入解除
 * 只读的事件，用户拒绝则保持只读。
 *
 * 为什么钉在 agent/pre-step 而不是 agent/created：
 *   新任务页的空白会话在打开时就已经建好 Agent，之后切换模式走的是 blank
 *   Session 的重新组合，不会再触发一次 agent/created。agent/pre-step 在
 *   turn/start 之前、请求组装之前，是运行时唯一的追加点；用「首轮」条件
 *   （lastTurn === 0）只钉一次，就能同时覆盖创建、空白会话切换、子代理继承
 *   三条路径，而且不会在后续轮次覆盖用户手动切换的权限（包括本插件自己批准的切换）。
 *
 * 依赖：宿主服务 agents / agentPresets / sandboxPolicy / approval / systemPrompt；
 * 工具部分额外需要 tools / userQuestions（缺失时工具不注册，守卫照常生效）。
 * 不导入任何 @deepseek-ai 包，事件按既有类型直接追加。
 */

export const name = 'readonly-guard'

/** 守卫必需的服务；工具依赖的 tools / userQuestions 用 ctx.inject 按需挂载。 */
export const inject = ['agents', 'agentPresets', 'sandboxPolicy', 'approval', 'systemPrompt']

/** 模型可见的只读说明。 */
const NOTICE = [
  'You are in read-only mode. Reading anywhere on this computer is allowed, but every file change is denied by the sandbox: creating, editing, deleting, moving, and renaming files, and any command that writes to disk.',
  'Do not attempt those operations and do not request a sandbox escalation. If the task needs a change, call request_standard_mode to ask the user for permission; the user must confirm before this session becomes writable, and a refusal keeps it read-only.',
].join(' ')

const DEFAULT_PRESET = 'readonly'
const DEFAULT_PERMISSION_PRESET = 'read-only-mode'
const DEFAULT_WRITABLE_PRESET = 'danger-full-access'
const DEFAULT_WRITABLE_MODE = 'danger-full-access'
const DEFAULT_WRITABLE_APPROVAL = 'never'
const READ_ONLY = 'read-only'

/** 申请切换工具与它的问题 id / 选项文案（模型侧的判断依赖这里保持唯一）。 */
const TOOL_NAME = 'request_standard_mode'
const QUESTION_ID = 'switch-to-standard-mode'
const APPROVE_LABEL = '允许切换到标准模式'
const REJECT_LABEL = '保持只读'

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 见 README 的配置表，全部可省略。
 */
export function apply(ctx, config = {}) {
  if (ctx === null || typeof ctx !== 'object') return
  const preset = stringOption(config, 'preset', DEFAULT_PRESET)
  const permissionPreset = stringOption(config, 'permissionPreset', DEFAULT_PERMISSION_PRESET)
  const writable = {
    preset: stringOption(config, 'writablePreset', DEFAULT_WRITABLE_PRESET),
    mode: stringOption(config, 'writableMode', DEFAULT_WRITABLE_MODE),
    approval: stringOption(config, 'writableApproval', DEFAULT_WRITABLE_APPROVAL),
  }

  // 1) 只读会话的模型可见说明（注册为运行时上下文，排在 approval 策略行之后）。
  if (ctx.systemPrompt !== undefined && typeof ctx.systemPrompt.context === 'function') {
    const base =
      typeof ctx.systemPrompt.getContextOrder === 'function'
        ? ctx.systemPrompt.getContextOrder('APPROVAL_POLICY')
        : undefined
    const order = typeof base === 'number' && Number.isFinite(base) ? base + 1 : 116
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: 'readonly:mode',
          order,
          text: (context) => noticeFor(ctx, context),
        }),
      'dsh-purewhite-toolkit: readonly prompt context',
    )
  }

  // 2) 首轮执行前把沙箱与审批钉死。
  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async ({ agent } = {}, next) => {
      const decision = await next()
      try {
        pinIfNeeded(ctx, agent?.session, preset, permissionPreset)
      } catch (error) {
        ctx.logger?.warn?.('readonly-guard: failed to pin read-only mode: %o', error)
      }
      return decision
    })
  }

  // 3) 受控出口：模型申请切到标准模式，必须用户确认。只在只读会话里出现在工具目录。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools', 'userQuestions'], (scope) => {
      if (scope?.tools === undefined || typeof scope.tools.register !== 'function') return
      const userQuestions = scope.userQuestions
      if (userQuestions === undefined || typeof userQuestions.ask !== 'function') return
      scope.tools.register(
        createRequestTool(ctx, writable, userQuestions),
        {
          // 只读会话可见；同时按预设兜底，保证首轮（模式还没被钉之前）工具目录里就有它。
          when: ({ agent }) =>
            agent !== undefined &&
            agent !== null &&
            (isReadOnly(ctx, agent.session) || presetFor(ctx, agent.session) === preset),
        },
      )
    })
  }

  // 4) 给客户端徽标用的会话投影：pinned（已钉只读）/ released（已解除只读）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], (scope) => {
      const projections = scope.sessionProjections
      if (projections === undefined || typeof projections.register !== 'function') return
      try {
        projections.register(READONLY_GUARD_PROJECTION)
      } catch (error) {
        ctx.logger?.warn?.('readonly-guard: failed to register projection: %o', error)
      }
    })
  }
}

/** 客户端可见的「已解除只读」徽标状态；状态与视图都由事件折叠得出。 */
const READONLY_GUARD_PROJECTION = {
  key: 'readonlyGuard',
  stateVersion: 1,
  // 不做结构校验：状态只在本插件内部产生，检查点回放同样走 apply。
  stateSchema: { parse: (value) => value },
  init: () => ({ pinned: false, released: false }),
  apply(state, event) {
    if (event.type !== 'sandbox/mode') return state
    if (event.data.mode === READ_ONLY) {
      return state.pinned && !state.released ? state : { pinned: true, released: false }
    }
    return state.pinned && !state.released ? { pinned: true, released: true } : state
  },
  wire: {
    viewSchema: { parse: (value) => value },
    view: (state) => ({ released: state.pinned && state.released }),
  },
}

/**
 * 会话属于只读预设、且还处在第一轮时，写入 read-only + never 两个旋钮事件。
 * 只在 first turn 生效，后续轮次与恢复会话都不再改写，用户手动切的权限不会被覆盖。
 * @param ctx Cordis 上下文。
 * @param session 当前会话。
 * @param preset 只读 Agent 预设的 id。
 * @param permissionPreset 记录意图用的权限预设键。
 */
function pinIfNeeded(ctx, session, preset, permissionPreset) {
  if (session === undefined || session === null) return
  if (typeof ctx.agentPresets?.presetForSession !== 'function') return
  if (ctx.agentPresets.presetForSession(session) !== preset) return

  const boundary =
    typeof ctx.agents?.turnBoundaryOf === 'function' ? ctx.agents.turnBoundaryOf(session) : undefined
  if (boundary === undefined || boundary === null || boundary.lastTurn !== 0) return

  const mode = ctx.sandboxPolicy.resolve({ session }).mode
  const approval = ctx.approval.effectivePolicy(session)
  if (mode === READ_ONLY && approval === 'never') return
  if (typeof session.append !== 'function') return

  session.append('permission/preset', { preset: permissionPreset })
  if (mode !== READ_ONLY) session.append('sandbox/mode', { mode: READ_ONLY })
  if (approval !== 'never') session.append('approval/policy', { policy: 'never' })
}

/**
 * 构造「申请切换到标准模式」工具。
 * execute 会阻塞到用户回答；只有用户选择允许，才写入解除只读的事件。
 * @param ctx Cordis 上下文。
 * @param writable 解除只读后要写入的旋钮值。
 * @param userQuestions 已注入的 userQuestions 服务（宿主的提问通道）。
 * @returns 工具定义。
 */
function createRequestTool(ctx, writable, userQuestions) {
  return {
    name: TOOL_NAME,
    description:
      '只在只读模式下可用：向用户申请把本会话切换到标准模式（可写文件）。' +
      '调用会阻塞到用户确认；用户允许后本会话解除只读，用户可以拒绝，拒绝则继续只读。' +
      '不要用其他方式尝试写入，也不要反复申请。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          switched: { type: 'boolean', required: true, description: '用户是否允许切换。' },
          message: { type: 'string', required: true, description: '给模型看的结论说明。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(_args, exec) {
      const agent = exec?.agent
      const session = agent?.session
      if (session === undefined || session === null) {
        return { switched: false, message: '当前调用没有可用会话，无法切换模式。' }
      }
      if (!isReadOnly(ctx, session)) {
        return { switched: false, message: '当前会话不是只读模式，无需切换，直接继续任务即可。' }
      }

      let answer
      try {
        answer = await userQuestions.ask({
          questions: [
            {
              id: QUESTION_ID,
              header: '切换到标准模式',
              question: '当前会话处于只读模式。是否允许 Agent 切换到标准模式（可写文件）？',
              options: [
                { label: APPROVE_LABEL, description: '解除只读：本会话可以修改、删除、移动文件。' },
                { label: REJECT_LABEL, description: '拒绝本次申请，会话继续只读。' },
              ],
            },
          ],
          ...(agent === undefined ? {} : { agent }),
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        })
      } catch (error) {
        return { switched: false, message: `没能向用户发起确认，继续只读：${error?.message ?? String(error)}` }
      }

      const picked = answer?.answers?.find((item) => item?.id === QUESTION_ID)?.selected ?? []
      if (!Array.isArray(picked) || !picked.includes(APPROVE_LABEL)) {
        return { switched: false, message: '用户没有允许切换，会话保持只读；请改用只读方式完成，或说明需要用户手动切换。' }
      }

      session.append('permission/preset', { preset: writable.preset })
      session.append('sandbox/mode', { mode: writable.mode })
      session.append('approval/policy', { policy: writable.approval })
      return { switched: true, message: '用户已允许切换，本会话现在可以写文件；继续原来的任务。' }
    },
  }
}

/**
 * 生成运行时上下文里的一句只读说明；非只读会话返回空串。
 * @param ctx Cordis 上下文。
 * @param context 请求组装上下文。
 * @returns 模型可见文本。
 */
function noticeFor(ctx, context) {
  const session = context?.agent?.session
  if (session === undefined || session === null) return ''
  return isReadOnly(ctx, session) ? NOTICE : ''
}

/**
 * 会话的有效沙箱模式是否为只读。
 * @param ctx Cordis 上下文。
 * @param session 目标会话。
 * @returns 只读为 true；服务缺失或解析失败按 false 处理。
 */
function isReadOnly(ctx, session) {
  if (session === undefined || session === null) return false
  try {
    return ctx.sandboxPolicy.resolve({ session }).mode === READ_ONLY
  } catch {
    return false
  }
}

/**
 * 会话记录的 Agent 预设 id。
 * @param ctx Cordis 上下文。
 * @param session 目标会话。
 * @returns 预设 id；无法读取时为 null。
 */
function presetFor(ctx, session) {
  if (session === undefined || session === null) return null
  try {
    return typeof ctx.agentPresets?.presetForSession === 'function'
      ? ctx.agentPresets.presetForSession(session)
      : null
  } catch {
    return null
  }
}

/**
 * 读取字符串型配置，空值回退默认值。
 * @param config 插件配置。
 * @param key 字段名。
 * @param fallback 缺省值。
 * @returns 配置值或默认值。
 */
function stringOption(config, key, fallback) {
  const value = config?.[key]
  return typeof value === 'string' && value !== '' ? value : fallback
}
