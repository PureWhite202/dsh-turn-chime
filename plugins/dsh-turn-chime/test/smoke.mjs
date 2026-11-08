// dsh-turn-chime 的自检脚本：用真实的 cordis 事件总线跑一遍插件逻辑，
// 把「响」替换成写标记文件，验证触发条件、音效分流与去抖。
import { Context } from 'file:///E:/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { apply } from '../index.js'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const marker = 'C:\\Users\\Administrator\\.dsh\\cache\\turn-chime-test.txt'
const log = []
const config = {
  // 走 shell 执行，重定向路径不能带空格。
  command: `echo chime >> ${marker}`,
  debug: true,
  debounceMs: 0,
}

if (existsSync(marker)) rmSync(marker)

const root = new Context()
root.logger = { info: (m) => log.push(['info', m]), warn: (m) => log.push(['warn', m]) }
const pluginCtx = root.extend({ name: 'turn-chime' })
apply(pluginCtx, config)

const chimeCount = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split(/\r?\n/).length : 0
const mainSession = { id: 'session-main', header: { origin: undefined } }
const subSession = { id: 'session-sub', header: { origin: 'subagent' } }
const turnEnd = (kind) => ({ type: 'turn/end', data: { turn: 1, reason: { kind } } })
const toolCall = (name) => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name, arguments: '{}' } })

const cases = []
const hit = async (label, session, kind, expectChime) => {
  const before = chimeCount()
  root.emit('session/event', session, turnEnd(kind))
  await sleep(600)
  const after = chimeCount()
  cases.push({ label, expected: expectChime ? 1 : 0, got: after - before })
}
const hitTool = async (label, session, name, expectChime) => {
  const before = chimeCount()
  root.emit('session/event', session, toolCall(name))
  await sleep(600)
  const after = chimeCount()
  cases.push({ label, expected: expectChime ? 1 : 0, got: after - before })
}

await hit('主会话 completed', mainSession, 'completed', true)
await hit('子代理会话 completed', subSession, 'completed', false)
await hit('主会话 aborted', mainSession, 'aborted', false)
await hit('主会话 error', mainSession, 'error', true)

// 提问：模型调用询问用户的工具时单独响一声
await hitTool('主会话 ask_user_question 响', mainSession, 'ask_user_question', true)
await hitTool('主会话 exit_plan_mode 响', mainSession, 'exit_plan_mode', true)
await hitTool('主会话 其他工具不响', mainSession, 'pwsh', false)
await hitTool('子代理提问不响', subSession, 'ask_user_question', false)

// 别的会话事件一概不理
const beforeOther = chimeCount()
root.emit('session/event', mainSession, { type: 'step/end', data: { turn: 1, step: 1 } })
root.emit('session/event', mainSession, { type: 'assistant/message', data: {} })
await sleep(600)
cases.push({ label: '非 turn/end 事件', expected: 0, got: chimeCount() - beforeOther })

// 音效分流：提问走 2.wav（上行），结束走 1.wav（下行）
const sounds = []
const routed = new Context()
routed.logger = { info: (m) => sounds.push(m), warn: (m) => sounds.push(m) }
apply(routed.extend(), { command: config.command, debug: true, debounceMs: 0 })
rmSync(marker, { force: true })
routed.emit('session/event', mainSession, toolCall('ask_user_question'))
routed.emit('session/event', mainSession, turnEnd('completed'))
await sleep(600)
cases.push({ label: '提问走 2.wav', expected: 1, got: sounds.some((s) => s.includes('2.wav')) ? 1 : 0 })
cases.push({ label: '完成走 1.wav', expected: 1, got: sounds.some((s) => s.includes('1.wav')) ? 1 : 0 })

// 配置里直接写数字（YAML 会把 1/2 解析成 number）也要认
const numericLogs = []
const numeric = new Context()
numeric.logger = { info: (m) => numericLogs.push(m), warn: (m) => numericLogs.push(m) }
apply(numeric.extend(), { sound: 2, command: config.command, debug: true, debounceMs: 0 })
numeric.emit('session/event', mainSession, turnEnd('completed'))
await sleep(600)
cases.push({ label: '数字配置 sound: 2', expected: 1, got: numericLogs.some((s) => s.includes('2.wav')) ? 1 : 0 })

// 去抖：同一时刻两个 turn/end 只响一次
rmSync(marker, { force: true })
const debounced = new Context()
apply(debounced.extend(), { command: config.command, debounceMs: 800 })
debounced.emit('session/event', mainSession, turnEnd('completed'))
debounced.emit('session/event', { id: 'session-2' }, turnEnd('completed'))
await sleep(600)
cases.push({ label: '去抖 800ms', expected: 1, got: chimeCount() })

// 提问与结束各自去抖：同一时刻各响各的，互不吞音
rmSync(marker, { force: true })
const separate = new Context()
apply(separate.extend(), { command: config.command, debounceMs: 800 })
separate.emit('session/event', mainSession, toolCall('ask_user_question'))
separate.emit('session/event', mainSession, turnEnd('completed'))
await sleep(600)
cases.push({ label: '提问与结束各自去抖', expected: 2, got: chimeCount() })

let failed = 0
for (const c of cases) {
  const ok = c.got === c.expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.label}: expected ${c.expected}, got ${c.got}`)
}
console.log('debug log lines:', log.length)
if (failed) { console.log(`${failed} case(s) failed`); process.exit(1) }
console.log('all cases passed')
