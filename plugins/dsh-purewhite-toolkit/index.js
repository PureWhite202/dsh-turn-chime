/**
 * dsh-purewhite-toolkit — 纯白莱茵自用 DSH 工具集。
 *
 * 目前提供一个工具：
 *   screenshot  截取整屏 / 指定窗口 / 指定区域，直接把图片作为 image 内容块返回给模型。
 *
 * 设计要点：
 *   - 宿主侧插件，纯对象注册工具（`ctx.tools.register`），不依赖任何 @deepseek-ai 包；
 *   - 截图走 `native/Capture.cs` 编译出的独立小进程（~0.2s/次），比 PowerShell 子进程快 7 倍；
 *   - 图片通过 `ctx.attachments.saveImage` 落成附件再以 image 块返回，模型一次调用就能看到画面；
 *   - 附件服务不可用时自动降级为「只给路径 + 提示」，不报错；
 *   - 截图文件默认保存到会话工作目录根，可用 outDir 覆盖。
 *
 * 平台：仅 Windows（依赖 user32/GDI+）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名，与 cordis.patch.yml 里的 name 一致。 */
export const name = 'dsh-purewhite-toolkit'

/** 需要的宿主服务：工具运行时。附件服务是可选依赖，运行期探测。 */
export const inject = ['tools']

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))
const BUILD_DIR = join(PLUGIN_ROOT, 'build')
const HELPER_EXE = join(BUILD_DIR, 'dshtool-capture.exe')
const HELPER_SRC = join(PLUGIN_ROOT, 'native', 'Capture.cs')
const FALLBACK_PS1 = join(PLUGIN_ROOT, 'native', 'fallback.ps1')
const SCRATCH_DIR = join(BUILD_DIR, '.scratch')

const TOOL_DESCRIPTION = [
  '截取当前 Windows 桌面并直接把画面返回给你（图片内容块，不需要再调用 read_image）。',
  'target=screen 截整屏（多屏会合成一张），target=window 截指定窗口，target=region 截指定矩形。',
  '窗口用 window 传标题子串（不区分大小写）或 hwnd 传句柄；窗口被最小化时默认返回 WINDOW_MINIMIZED，需要截就用 restore=true（窗口会短暂显示约 0.4 秒）。',
  '默认保存到会话工作目录根，可用 outDir 指定目录、fileName 指定文件名；save=false 只返回图片不落盘。',
  '截图内容会包含桌面上的敏感信息，调用前请确认用户知情。',
].join(' ')

const PARAMETERS = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: ['screen', 'window', 'region'],
      description: '截取目标。缺省 screen。',
    },
    window: {
      type: 'string',
      description: 'target=window 时用：窗口标题的子串，不区分大小写。',
    },
    hwnd: {
      type: 'integer',
      description: 'target=window 时用：精确窗口句柄，优先级高于 window。',
    },
    restore: {
      type: 'boolean',
      description: '目标窗口最小化时是否临时恢复后截图，默认 false。会短暂显示该窗口。',
    },
    region: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['x', 'y', 'width', 'height'],
      description: 'target=region 时用：虚拟桌面物理像素坐标与尺寸。',
    },
    monitor: {
      type: 'integer',
      description: '显示器序号，1 起；缺省或 0 表示所有屏幕合成的那一张。',
    },
    scale: {
      type: 'number',
      description: '缩放比例 0.1–1，用于省 token；缺省按配置的 maxLongEdge 自动缩。',
    },
    format: {
      type: 'string',
      enum: ['png', 'jpeg'],
      description: '图片格式，缺省 png。',
    },
    cursor: {
      type: 'boolean',
      description: '是否把鼠标指针画进图里，缺省 false。',
    },
    outDir: {
      type: 'string',
      description: '保存目录。相对路径按会话工作目录解析；缺省会话工作目录根。',
    },
    fileName: {
      type: 'string',
      description: '保存文件名，缺省按时间生成。',
    },
    save: {
      type: 'boolean',
      description: '是否落盘，缺省 true。false 时只返回图片内容。',
    },
  },
  required: [],
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    message: { type: 'string' },
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    capture: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['screen', 'monitor', 'window', 'region'] },
        title: { type: 'string' },
        hwnd: { type: 'integer' },
        wasMinimized: { type: 'boolean' },
        dpiAdjusted: { type: 'boolean' },
        bounds: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
    },
    image: IMAGE_VALUE_SCHEMA,
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 见 README 的配置表，全部可省略。
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config ?? {})
  if (!options.enabled) return
  if (ctx === null || typeof ctx !== 'object') return
  if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') return

  const definition = createScreenshotTool(ctx, options)
  const register = () => ctx.tools.register(definition)
  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'dsh-purewhite-toolkit: screenshot')
  } else {
    register()
  }
}

/**
 * 构造工具定义。独立导出便于测试与将来的多工具扩展。
 * @param ctx Cordis 上下文（用于取 attachments）。
 * @param options 规范化后的配置。
 * @returns 可直接交给 ctx.tools.register 的工具定义。
 */
export function createScreenshotTool(ctx, options) {
  return {
    name: options.toolName,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderValue(value),
    },
    isConcurrencySafe: () => true,

    async execute(args, exec) {
      const sessionCwd = readSessionCwd(exec)
      const target = normalizeTarget(args)
      const format = normalizeFormat(args.format, options.format)
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png'

      const warnings = []
      let scratch
      try {
        mkdirSync(SCRATCH_DIR, { recursive: true })
      } catch (error) {
        return failure('SCRATCH_UNAVAILABLE', `无法创建临时目录 ${SCRATCH_DIR}: ${error.message}`)
      }

      scratch = join(SCRATCH_DIR, `shot-${Date.now()}-${randomSuffix()}.${ext}`)

      try {
        const argv = buildHelperArgs(args, target, format, scratch, options)
        const outcome = await runCapture(argv, options, scratch, format)
        if (!outcome.ok) {
          const message = outcome.candidates && outcome.candidates.length > 0
            ? `${outcome.message}\n可见窗口：${outcome.candidates.map((item) => item.title).join(' | ')}`
            : outcome.message
          return failure(outcome.code ?? 'CAPTURE_FAILED', message)
        }

        const bytes = readFileSync(outcome.path)
        const rawWidth = outcome.width ?? 0
        const rawHeight = outcome.height ?? 0
        const blank = (outcome.uniform ?? 0) >= options.blankUniformity && (outcome.mean ?? 255) < 12
        const value = {
          ok: !blank,
          width: rawWidth,
          height: rawHeight,
          bytes: bytes.length,
          capture: buildCaptureInfo(target, outcome),
          warnings: [...warnings, ...(outcome.warnings ?? [])],
        }

        if (blank) {
          value.code = 'BLANK_CAPTURE'
          value.message = '截到的画面是纯色（可能是锁屏、UAC 提权弹窗挡住了桌面，或目标窗口没有可渲染内容）。'
        }

        if (options.save !== false && args.save !== false) {
          const outDir = resolveOutDir(args.outDir, options.saveDir, sessionCwd)
          const prefix = target === 'window' ? 'window' : 'screen'
          const fileName = typeof args.fileName === 'string' && args.fileName.trim() !== ''
            ? sanitizeFileName(args.fileName.trim(), ext)
            : `${prefix}-${timestamp()}.${ext}`
          const finalPath = join(outDir, fileName)
          try {
            mkdirSync(outDir, { recursive: true })
            writeFileSync(finalPath, bytes)
            value.path = finalPath
          } catch (error) {
            value.path = finalPath
            value.warnings.push(`SAVE_FAILED:${error.code ?? error.message}`)
          }
        }

        if (value.ok) {
          try {
            const image = await attachImage(ctx, bytes, mediaType, value.path)
            if (image === undefined) {
              value.warnings.push('ATTACHMENTS_UNAVAILABLE: 图片无法作为内容块返回，只能给路径；请用 read_image 读取')
            } else {
              value.image = image
            }
          } catch (error) {
            value.warnings.push(`ATTACH_FAILED:${error.code ?? error.message}`)
          }
        }

        return value
      } catch (error) {
        return failure(error.code ?? 'CAPTURE_FAILED', error.message ?? String(error))
      } finally {
        safeRemove(scratch)
      }
    },
  }
}

// ---------- 执行 ----------

function buildHelperArgs(args, target, format, outPath, options) {
  const argv = ['--mode', target, '--out', outPath, '--format', format]

  const scale = Number(args.scale)
  if (Number.isFinite(scale) && scale > 0 && scale < 1) {
    argv.push('--scale', String(scale))
  } else if (Number.isFinite(options.maxLongEdge) && options.maxLongEdge > 0) {
    argv.push('--maxedge', String(Math.round(options.maxLongEdge)))
  }

  if (args.cursor === true || (args.cursor === undefined && options.cursor === true)) argv.push('--cursor', '1')
  if (target === 'window') {
    const hwnd = Number(args.hwnd)
    if (Number.isFinite(hwnd) && hwnd > 0) argv.push('--hwnd', String(Math.trunc(hwnd)))
    else if (typeof args.window === 'string') argv.push('--title', args.window)
    if (args.restore === true) argv.push('--restore', '1')
  }
  if (target === 'monitor') {
    const monitor = Number(args.monitor)
    if (Number.isFinite(monitor) && monitor > 0) argv.push('--monitor', String(Math.trunc(monitor)))
  }
  if (target === 'region') {
    const region = args.region ?? {}
    argv.push('--x', String(Math.trunc(Number(region.x) || 0)))
    argv.push('--y', String(Math.trunc(Number(region.y) || 0)))
    argv.push('--w', String(Math.trunc(Number(region.width) || 0)))
    argv.push('--h', String(Math.trunc(Number(region.height) || 0)))
  }
  return argv
}

function normalizeTarget(args) {
  if (args.target === 'window') return 'window'
  if (args.target === 'region') return 'region'
  const monitor = Number(args.monitor)
  if (Number.isFinite(monitor) && monitor > 0) return 'monitor'
  return 'screen'
}

async function runCapture(argv, options, scratch, format) {
  const backend = await resolveBackend(options)
  const child = backend === 'powershell'
    ? spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FALLBACK_PS1,
      '-Out', scratch, '-Format', format === 'jpeg' ? 'jpeg' : 'png',
      '-MaxEdge', String(Number.isFinite(options.maxLongEdge) ? Math.round(options.maxLongEdge) : 0),
    ], { windowsHide: true })
    : spawn(HELPER_EXE, argv, { windowsHide: true })

  return await new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolvePromise({ ok: false, code: 'CAPTURE_TIMEOUT', message: '截图进程超时（20s）' })
    }, 20000)

    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, code: 'CAPTURE_SPAWN_FAILED', message: error.message })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const parsed = parseJsonLine(stdout)
      if (parsed === undefined) {
        resolvePromise({
          ok: false,
          code: 'CAPTURE_BAD_OUTPUT',
          message: (stdout || stderr || '截图进程没有输出可解析的 JSON').slice(0, 400),
        })
        return
      }
      resolvePromise(parsed)
    })
  })
}

async function resolveBackend(options) {
  if (options.backend === 'powershell') return 'powershell'
  try {
    await ensureHelper()
    return 'helper'
  } catch (error) {
    if (options.backend === 'helper') throw error
    // 编译失败时退到 PowerShell（仅整屏能力）。
    return 'powershell'
  }
}

let helperPromise
function ensureHelper() {
  if (helperPromise === undefined) helperPromise = buildHelper()
  return helperPromise
}

async function buildHelper() {
  if (isUpToDate()) return HELPER_EXE
  const csc = findCsc()
  if (csc === undefined) {
    throw Object.assign(new Error('找不到 csc.exe（.NET Framework 4.x 编译器），无法编译截图 helper'), { code: 'HELPER_COMPILER_MISSING' })
  }
  mkdirSync(BUILD_DIR, { recursive: true })
  // 注意：csc 对正斜杠的源文件路径会解析错，必须传 Windows 反斜杠路径。
  const result = spawnSync(csc, [
    '/nologo', '/target:exe', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    `/out:${HELPER_EXE}`, HELPER_SRC,
  ], { windowsHide: true, timeout: 60000, encoding: 'utf8' })
  if (result.status !== 0 || !existsSync(HELPER_EXE)) {
    throw Object.assign(new Error(`编译截图 helper 失败：${(result.stderr || result.stdout || '').slice(0, 300)}`), { code: 'HELPER_BUILD_FAILED' })
  }
  return HELPER_EXE
}

function isUpToDate() {
  try {
    if (!existsSync(HELPER_EXE)) return false
    if (!existsSync(HELPER_SRC)) return true
    return statSync(HELPER_EXE).mtimeMs >= statSync(HELPER_SRC).mtimeMs
  } catch {
    return false
  }
}

function findCsc() {
  const root = process.env.WINDIR ?? 'C:\\Windows'
  for (const suite of ['Framework64', 'Framework']) {
    const candidate = join(root, 'Microsoft.NET', suite, 'v4.0.30319', 'csc.exe')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function attachImage(ctx, bytes, mediaType, displayPath) {
  let attachments
  try {
    attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : ctx.attachments
  } catch {
    attachments = undefined
  }
  if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') return undefined

  const name = displayPath === undefined ? undefined : displayPath.split(/[\\/]/).pop()
  const ref = await attachments.saveImage({ data: bytes, mediaType, ...(name === undefined ? {} : { name }) })
  const image = {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
  if (ref.name !== undefined) image.name = ref.name
  return image
}

// ---------- 渲染 ----------

function renderValue(value) {
  const lines = []
  if (value.ok !== true) {
    lines.push(`<screenshot-error>${value.code ?? 'CAPTURE_FAILED'}</screenshot-error>`)
    if (value.message !== undefined) lines.push(`<message>${value.message}</message>`)
    if (value.path !== undefined) lines.push(`<path>${value.path}</path>`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (value.path !== undefined) lines.push(`<path>${value.path}</path>`)
  lines.push('<type>screenshot</type>')
  lines.push('<content>')
  const parts = [`${value.width}x${value.height} px`]
  if (value.bytes !== undefined) parts.push(`${value.bytes} bytes`)
  const capture = value.capture ?? {}
  if (capture.kind !== undefined) parts.push(`target=${capture.kind}`)
  if (capture.title !== undefined) parts.push(`window="${capture.title}"`)
  if (capture.wasMinimized === true) parts.push('restored-from-minimized')
  lines.push(parts.join(', '))
  lines.push('</content>')
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push(`<warnings>${value.warnings.join('; ')}</warnings>`)
  }
  if (value.image === undefined) {
    lines.push('<note>图片没有作为内容块附加，请用 read_image 读取上面的 path。</note>')
    return [{ type: 'text', text: lines.join('\n') }]
  }

  return [
    { type: 'text', text: lines.join('\n') },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

function imageRefFromValue(image) {
  const ref = {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
  }
  if (image.name !== undefined) ref.name = image.name
  return ref
}

// ---------- 杂项 ----------

function normalizeConfig(raw) {
  const config = raw ?? {}
  return {
    enabled: config.enabled !== false,
    toolName: typeof config.toolName === 'string' && config.toolName.trim() !== '' ? config.toolName.trim() : 'screenshot',
    format: config.format === 'jpeg' ? 'jpeg' : 'png',
    maxLongEdge: Number.isFinite(Number(config.maxLongEdge)) ? Math.max(0, Math.trunc(Number(config.maxLongEdge))) : 1600,
    save: config.save !== false,
    saveDir: typeof config.saveDir === 'string' ? config.saveDir : '',
    cursor: config.cursor === true,
    backend: config.backend === 'helper' || config.backend === 'powershell' ? config.backend : 'auto',
    blankUniformity: Number.isFinite(Number(config.blankUniformity)) ? Number(config.blankUniformity) : 0.995,
  }
}

function normalizeFormat(requested, fallback) {
  if (requested === 'jpeg' || requested === 'jpg') return 'jpeg'
  if (requested === 'png') return 'png'
  return fallback === 'jpeg' ? 'jpeg' : 'png'
}

function readSessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  const direct = exec?.cwd
  if (typeof direct === 'string' && direct !== '') return direct
  return process.cwd()
}

function resolveOutDir(requested, configured, base) {
  const raw = typeof requested === 'string' && requested.trim() !== ''
    ? requested.trim()
    : (typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : '')
  if (raw === '') return base
  return isAbsolute(raw) ? raw : resolve(base, raw)
}

function buildCaptureInfo(target, outcome) {
  const info = { kind: target }
  if (outcome.window !== undefined) {
    if (outcome.window.title !== undefined) info.title = outcome.window.title
    if (outcome.window.hwnd !== undefined) info.hwnd = outcome.window.hwnd
    if (outcome.window.wasMinimized === true) info.wasMinimized = true
    if (outcome.window.dpiAdjusted === true) info.dpiAdjusted = true
  }
  if (outcome.bounds !== undefined) info.bounds = outcome.bounds
  return info
}

function failure(code, message) {
  return { ok: false, code, message }
}

function parseJsonLine(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return undefined
  const lines = trimmed.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // 继续尝试上一行
    }
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

function sanitizeFileName(name, ext) {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned === '' ? `screen-${timestamp()}.${ext}` : cleaned
}

function safeRemove(path) {
  if (typeof path !== 'string' || path === '') return
  try {
    rmSync(path, { force: true })
  } catch {
    // 临时文件清理失败不影响结果
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}
