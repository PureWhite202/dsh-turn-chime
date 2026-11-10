/**
 * dsh-purewhite-toolkit — 纯白莱茵自用 DSH 工具集。
 *
 * 目前提供一个工具：
 *   screenshot  截取整屏 / 指定窗口 / 指定区域，直接把图片作为 image 内容块返回给模型。
 *
 * 设计要点：
 *   - 宿主侧插件，纯对象注册工具（`ctx.tools.register`），不依赖任何 @deepseek-ai 包；
 *   - Windows：截图走 `native/Capture.cs` 编译出的独立小进程（~0.2s/次），比 PowerShell 子进程快 7 倍；
 *   - macOS：走系统自带的 `/usr/sbin/screencapture` + `sips`，窗口枚举用 JXA 调 CoreGraphics，
 *     无第三方依赖（首次使用需在「系统设置 → 隐私与安全性 → 屏幕录制」里授权宿主 App）；
 *   - 图片通过 `ctx.attachments.saveImage` 落成附件再以 image 块返回，模型一次调用就能看到画面；
 *   - 附件服务不可用时自动降级为「只给路径 + 提示」，不报错；
 *   - 截图文件默认保存到会话工作目录根，可用 outDir 覆盖。
 *
 * 平台：Windows（user32/GDI+）与 macOS（screencapture）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名，与 cordis.patch.yml 里的 name 一致。 */
export const name = 'dsh-purewhite-toolkit'

/** 需要的宿主服务：工具运行时。附件服务是可选依赖，运行期探测。 */
export const inject = ['tools']

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills')
const BUILD_DIR = join(PLUGIN_ROOT, 'build')
const HELPER_EXE = join(BUILD_DIR, 'dshtool-capture.exe')
const HELPER_SRC = join(PLUGIN_ROOT, 'native', 'Capture.cs')
const FALLBACK_PS1 = join(PLUGIN_ROOT, 'native', 'fallback.ps1')
const SCRATCH_DIR = join(BUILD_DIR, '.scratch')

/** 当前平台；macOS 走 screencapture，其余（Windows）走 helper/PowerShell。 */
const IS_MAC = process.platform === 'darwin'
const SCREENCAPTURE_BIN = '/usr/sbin/screencapture'
const SIPS_BIN = '/usr/bin/sips'
const OSASCRIPT_BIN = '/usr/bin/osascript'

const PLATFORM_LABEL = IS_MAC ? 'macOS' : 'Windows'

const TOOL_DESCRIPTION = [
  `截取当前 ${PLATFORM_LABEL} 桌面并直接把画面返回给你（图片内容块，不需要再调用 read_image）。`,
  IS_MAC
    ? 'target=screen 截整屏（多显示器会按桌面布局合成一张），target=window 按窗口标题或进程名匹配，target=region 截指定矩形（坐标为点，原点在主屏左上角）。'
    : 'target=screen 截整屏（多屏会合成一张），target=window 截指定窗口，target=region 截指定矩形。',
  IS_MAC
    ? '窗口用 window 传标题子串（不区分大小写，匹配不到标题时再匹配进程名）或 hwnd 传 CGWindowID；窗口最小化时返回 WINDOW_MINIMIZED（macOS 不支持自动恢复），需要截请先手动恢复。'
    : '窗口用 window 传标题子串（不区分大小写）或 hwnd 传句柄；窗口被最小化时默认返回 WINDOW_MINIMIZED，需要截就用 restore=true（窗口会短暂显示约 0.4 秒）。',
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
      description: IS_MAC
        ? 'target=window 时用：精确窗口编号（CGWindowID），优先级高于 window。'
        : 'target=window 时用：精确窗口句柄，优先级高于 window。',
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
      description: IS_MAC
        ? 'target=region 时用：屏幕坐标与尺寸（点，原点在主显示器左上角）。'
        : 'target=region 时用：虚拟桌面物理像素坐标与尺寸。',
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

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    const definition = createScreenshotTool(ctx, options)
    const register = () => ctx.tools.register(definition)
    if (typeof ctx.effect === 'function') {
      ctx.effect(register, 'dsh-purewhite-toolkit: screenshot')
    } else {
      register()
    }
  }

  if (options.skills) registerBundledSkills(ctx)
}

/**
 * 把插件自带的技能（skills/<名字>/SKILL.md）注册进宿主技能表。
 * 技能服务不存在或解析失败时静默跳过，绝不影响 screenshot 工具。
 * @param ctx Cordis 上下文。
 */
function registerBundledSkills(ctx) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['skills'], (skillsCtx) => {
      let skills
      try {
        skills = skillsCtx.skills
      } catch {
        return
      }
      if (skills === undefined || skills === null || typeof skills.register !== 'function') return
      let entries
      try {
        entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const filePath = join(SKILLS_DIR, entry.name, 'SKILL.md')
        let skill
        try {
          skill = readBundledSkill(filePath)
        } catch {
          continue
        }
        if (skill === undefined) continue
        try {
          const register = () => skills.register({ ...skill, path: filePath })
          if (typeof skillsCtx.effect === 'function') {
            skillsCtx.effect(register, `dsh-purewhite-toolkit: skill ${skill.name}`)
          } else {
            register()
          }
        } catch (error) {
          warnSafely(skillsCtx, `dsh-purewhite-toolkit: 技能 ${skill.name} 注册失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
  } catch (error) {
    warnSafely(ctx, `dsh-purewhite-toolkit: 无法注入 skills 服务：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 读插件自带的 SKILL.md：frontmatter 只取 name / description，正文原样。
 * @param filePath SKILL.md 绝对路径。
 * @returns {{name: string, description: string, content: string}|undefined}
 */
function readBundledSkill(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const frontmatter = match === null ? '' : match[1]
  const content = (match === null ? raw : raw.slice(match[0].length)).trim()
  const nameMatch = /^name:\s*(.+)$/mu.exec(frontmatter)
  const descriptionMatch = /^description:\s*(.+)$/mu.exec(frontmatter)
  if (nameMatch === null || descriptionMatch === null) return undefined
  const unquote = (value) => String(value).trim().replace(/^(["'])([\s\S]*)\1$/u, '$2')
  const name = unquote(nameMatch[1])
  const description = unquote(descriptionMatch[1])
  if (name === '' || description === '' || content === '') return undefined
  return { name, description, content }
}

/** 宿主有 logger 就记一条警告，没有/不许访问就静默。 */
function warnSafely(ctx, message) {
  try {
    const logger = ctx?.logger
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') logger.warn(message)
  } catch {
    // 拿不到 logger 就算了
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
        const outcome = IS_MAC
          ? await runMacCapture({ args, target, options, format, outPath: scratch })
          : await runCapture(buildHelperArgs(args, target, format, scratch, options), options, scratch, format)
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

// ---------- macOS 后端（screencapture + sips + JXA/CoreGraphics） ----------

/** 用 JXA 通过 CoreGraphics 列出所有窗口（含最小化），由 Node 侧做匹配。 */
const MAC_WINDOW_SCRIPT = `ObjC.import('CoreGraphics');
function run() {
  var ref = $.CGWindowListCopyWindowInfo(0, $.kCGNullWindowID);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref));
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    var w = list[i];
    if (!w || w.kCGWindowLayer !== 0) continue;
    var b = w.kCGWindowBounds || {};
    var width = Number(b.Width || 0);
    var height = Number(b.Height || 0);
    if (!(width > 40 && height > 40)) continue;
    out.push({
      id: Number(w.kCGWindowNumber),
      title: String(w.kCGWindowName || ''),
      owner: String(w.kCGWindowOwnerName || ''),
      x: Number(b.X || 0),
      y: Number(b.Y || 0),
      width: width,
      height: height,
      onscreen: w.kCGWindowIsOnscreen === true
    });
  }
  return JSON.stringify(out);
}`

/** 用 JXA 读 NSScreen 的 frame，供多显示器合成时算联合矩形。 */
const MAC_SCREEN_SCRIPT = `ObjC.import('AppKit');
function run() {
  var screens = $.NSScreen.screens;
  var out = [];
  for (var i = 0; i < screens.count; i += 1) {
    var f = screens.objectAtIndex(i).frame;
    out.push({ x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height });
  }
  return JSON.stringify(out);
}`

/**
 * macOS 截图主流程：screencapture 出 PNG → sips 缩放 → sips 缩略 BMP 统计 → sips 转档。
 * @param {{args: object, target: string, options: object, format: string, outPath: string}} input
 * @returns {Promise<object>} 与 Windows helper 同形的结果对象。
 */
async function runMacCapture({ args, target, options, format, outPath }) {
  const stamp = `${Date.now()}-${randomSuffix()}`
  const srcPng = join(SCRATCH_DIR, `mac-${stamp}.src.png`)
  const sizedPng = join(SCRATCH_DIR, `mac-${stamp}.sized.png`)
  const thumbBmp = join(SCRATCH_DIR, `mac-${stamp}.thumb.bmp`)
  const warnings = []
  let window
  let bounds

  try {
    const argv = ['-x', '-t', 'png']
    if (args.cursor === true || (args.cursor === undefined && options.cursor === true)) argv.push('-C')

    if (target === 'window') {
      const picked = await pickMacWindow(args)
      if (!picked.ok) return picked
      window = picked.window
      if (window.minimized) {
        // macOS 拿不到“最小化”与“在别的桌面/空间”的区分，两者都可能截到窗口内容，给个逃生口。
        if (args.restore !== true) {
          return {
            ok: false,
            code: 'WindowMinimized',
            message: `窗口 ${window.id}「${window.title || window.owner}」不在当前桌面或已最小化；macOS 不支持自动恢复，可传 restore=true 尝试直接捕获，或先手动切到该窗口`,
          }
        }
        warnings.push('WINDOW_NOT_ON_SCREEN: 窗口不在当前桌面或已最小化，尝试直接捕获')
      }
      argv.push('-o', '-l', String(window.id))
      bounds = { x: window.x, y: window.y, width: window.width, height: window.height }
    } else if (target === 'region') {
      const region = normalizeRegion(args.region)
      if (region.width <= 0 || region.height <= 0) {
        return { ok: false, code: 'RegionMissing', message: 'target=region 需要 region.width 与 region.height（macOS 单位为点）' }
      }
      argv.push('-R', `${region.x},${region.y},${region.width},${region.height}`)
      bounds = region
    } else if (target === 'monitor') {
      argv.push('-D', String(Math.trunc(Number(args.monitor))))
    } else {
      // 整屏：多显示器按桌面布局取联合矩形，单显示器等价于主屏。
      const union = await macDisplayUnion()
      if (union !== undefined) {
        argv.push('-R', `${union.x},${union.y},${union.width},${union.height}`)
        bounds = union
      }
    }

    argv.push(srcPng)
    const captured = await runCommand(SCREENCAPTURE_BIN, argv, 20000)
    if (!captured.ok) return captured.error
    if (!existsSync(srcPng) || statSync(srcPng).size === 0) {
      const detail = captured.stderr.trim()
      return {
        ok: false,
        code: 'CAPTURE_FAILED',
        message: `screencapture 没有生成图片${detail === '' ? '' : `：${detail.slice(0, 300)}`}`,
      }
    }

    // 长边缩放：显式 scale 优先，其次配置的 maxLongEdge。
    const natural = pngDimensions(srcPng)
    let width = natural.width
    let height = natural.height
    let source = srcPng
    const longEdge = Math.max(width, height)
    const scale = Number(args.scale)
    let maxEdge = 0
    if (Number.isFinite(scale) && scale > 0 && scale < 1) maxEdge = Math.round(longEdge * scale)
    else if (Number.isFinite(options.maxLongEdge) && options.maxLongEdge > 0) maxEdge = Math.round(options.maxLongEdge)
    if (maxEdge > 0 && maxEdge < longEdge) {
      const resized = runCommandSync(SIPS_BIN, ['-Z', String(maxEdge), '--out', sizedPng, srcPng], 30000)
      if (resized.ok && existsSync(sizedPng)) {
        source = sizedPng
        const size = pngDimensions(sizedPng)
        width = size.width
        height = size.height
      } else {
        warnings.push(`RESIZE_FAILED:${resized.stderr.trim().slice(0, 200) || 'sips 未生成缩放图'}`)
      }
    }

    // 纯色/黑屏判定：缩到 24px 的 BMP 上采样统计，口径与 Windows helper 一致。
    let mean = 255
    let uniform = 0
    const thumb = runCommandSync(SIPS_BIN, ['-Z', '24', '-s', 'format', 'bmp', '--out', thumbBmp, source], 30000)
    if (thumb.ok && existsSync(thumbBmp)) {
      const stats = analyzeBmp(readFileSync(thumbBmp))
      mean = stats.mean
      uniform = stats.uniform
    } else {
      warnings.push('STATS_UNAVAILABLE: 无法统计画面信息')
    }

    if (format === 'jpeg') {
      const converted = runCommandSync(SIPS_BIN, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', '--out', outPath, source], 30000)
      if (!converted.ok || !existsSync(outPath)) {
        return { ok: false, code: 'CONVERT_FAILED', message: `转换为 JPEG 失败：${converted.stderr.trim().slice(0, 300)}` }
      }
    } else {
      copyFileSync(source, outPath)
    }

    const result = { ok: true, path: outPath, width, height, mean, uniform, warnings }
    if (bounds !== undefined) result.bounds = bounds
    if (window !== undefined) {
      result.window = {
        hwnd: window.id,
        title: window.title || window.owner,
        wasMinimized: window.minimized === true,
        dpiAdjusted: false,
      }
    }
    return result
  } finally {
    safeRemove(srcPng)
    safeRemove(sizedPng)
    safeRemove(thumbBmp)
  }
}

/**
 * 按标题（优先）或进程名挑选窗口；hwnd 直接当 CGWindowID。
 * @param {object} args 工具入参。
 * @returns {Promise<object>} {ok:true, window} 或 {ok:false, code, message}。
 */
async function pickMacWindow(args) {
  const listed = await listMacWindows()
  if (!listed.ok) return listed.error
  return selectMacWindow(listed.windows, args)
}

/**
 * 在窗口列表里挑目标：hwnd 直接当 CGWindowID；否则按
 * 「进程名精确 > 标题精确 > 标题前缀 > 标题包含 > 进程名包含」打分，
 * 同分时优先在屏、面积大的窗口。
 * @param {object[]} windows listMacWindows 的结果。
 * @param {object} args 工具入参。
 * @returns {object} {ok:true, window} 或 {ok:false, code, message}。
 */
export function selectMacWindow(windows, args) {
  const hwnd = Number(args.hwnd)
  const hasHwnd = Number.isFinite(hwnd) && hwnd > 0
  const title = typeof args.window === 'string' ? args.window.trim() : ''
  if (!hasHwnd && title === '') {
    return { ok: false, code: 'WindowSelectorMissing', message: "target=window 需要 window（标题子串）或 hwnd（CGWindowID）" }
  }

  if (hasHwnd) {
    const picked = windows.find((item) => item.id === Math.trunc(hwnd))
    if (picked === undefined) {
      return { ok: false, code: 'WindowNotFound', message: `没有编号为 ${hwnd} 的可见窗口\n可见窗口：${formatCandidates(windows)}` }
    }
    return { ok: true, window: { ...picked, minimized: picked.onscreen === false } }
  }

  const query = title.toLowerCase()
  let best
  let bestScore = 0
  for (const item of windows) {
    const score = macWindowScore(item, query)
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  if (best === undefined) {
    return {
      ok: false,
      code: 'WindowNotFound',
      message: `没有可见窗口的标题或进程名包含 "${title}"\n可见窗口：${formatCandidates(windows)}`,
    }
  }
  return { ok: true, window: { ...best, minimized: best.onscreen === false } }
}

function macWindowScore(window, query) {
  const title = String(window.title ?? '').toLowerCase()
  const owner = String(window.owner ?? '').toLowerCase()
  let score = 0
  if (owner === query) score += 1000
  else if (owner.includes(query)) score += 400
  if (title === query) score += 900
  else if (title.startsWith(query)) score += 500
  else if (title.includes(query)) score += 200
  if (score === 0) return 0
  if (window.onscreen === true) score += 50
  const area = (Number(window.width) || 0) * (Number(window.height) || 0)
  score += Math.min(area / 1e6, 20)
  // 标题越长越可能是“碰巧包含”，轻微降权。
  score -= Math.min(title.length, 300) / 100
  return score
}

async function listMacWindows() {
  const scriptPath = join(SCRATCH_DIR, 'list-windows.js')
  try {
    writeFileSync(scriptPath, MAC_WINDOW_SCRIPT)
  } catch (error) {
    return { ok: false, error: { ok: false, code: 'WINDOW_ENUM_FAILED', message: `无法写入窗口枚举脚本：${error.message}` } }
  }
  const result = await runCommand(OSASCRIPT_BIN, ['-l', 'JavaScript', scriptPath], 15000)
  if (!result.ok) return { ok: false, error: result.error }
  const windows = parseJsonArray(result.stdout)
  if (windows === undefined) {
    return { ok: false, error: { ok: false, code: 'WINDOW_ENUM_FAILED', message: `窗口枚举输出无法解析：${result.stdout.slice(0, 200)}` } }
  }
  return { ok: true, windows }
}

/**
 * 所有显示器的联合矩形（screencapture -R 坐标系：主屏左上角为原点）。
 * 单显示器时就是主屏；拿不到信息时返回 undefined，退回默认截图。
 */
async function macDisplayUnion() {
  const scriptPath = join(SCRATCH_DIR, 'list-screens.js')
  try {
    writeFileSync(scriptPath, MAC_SCREEN_SCRIPT)
  } catch {
    return undefined
  }
  const result = await runCommand(OSASCRIPT_BIN, ['-l', 'JavaScript', scriptPath], 15000)
  if (!result.ok) return undefined
  const screens = parseJsonArray(result.stdout)
  if (screens === undefined || screens.length === 0) return undefined

  const main = screens.find((screen) => screen.x === 0 && screen.y === 0) ?? screens[0]
  const mainHeight = Number(main.height) || 0
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const screen of screens) {
    const x = Number(screen.x) || 0
    const y = Number(screen.y) || 0
    const width = Number(screen.width) || 0
    const height = Number(screen.height) || 0
    const topY = mainHeight - (y + height)
    left = Math.min(left, x)
    top = Math.min(top, topY)
    right = Math.max(right, x + width)
    bottom = Math.max(bottom, topY + height)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) return undefined
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  }
}

function normalizeRegion(region) {
  const source = region ?? {}
  return {
    x: Math.trunc(Number(source.x) || 0),
    y: Math.trunc(Number(source.y) || 0),
    width: Math.trunc(Number(source.width) || 0),
    height: Math.trunc(Number(source.height) || 0),
  }
}

function formatCandidates(windows) {
  const usable = windows.slice().sort((left, right) => Number(right.onscreen) - Number(left.onscreen)).slice(0, 8)
  if (usable.length === 0) return '(没有可见窗口)'
  return usable.map((item) => `${item.owner} — ${item.title === '' ? '(无标题)' : item.title}`).join(' | ')
}

function parseJsonArray(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('[')) return undefined
  try {
    const value = JSON.parse(trimmed)
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** 读 PNG 的 IHDR 拿宽高（screencapture/sips 输出都是 PNG）。 */
function pngDimensions(path) {
  try {
    const buffer = readFileSync(path)
    if (buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
  } catch {
    // 读不到按 0 处理
  }
  return { width: 0, height: 0 }
}

/** 解析 sips 输出的 BMP，算亮度均值与最大同色占比（与 Capture.cs 的 Analyze 同口径）。 */
export function analyzeBmp(buffer) {
  if (buffer.length < 54) return { mean: 0, uniform: 1 }
  const offset = buffer.readUInt32LE(10)
  const width = buffer.readInt32LE(18)
  const rawHeight = buffer.readInt32LE(22)
  const bpp = buffer.readUInt16LE(28)
  const height = Math.abs(rawHeight)
  if (width <= 0 || height === 0 || bpp < 24) return { mean: 0, uniform: 1 }

  const bytesPerPixel = Math.max(1, Math.floor(bpp / 8))
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4
  const topDown = rawHeight < 0
  const step = Math.max(1, Math.floor(Math.min(width, height) / 200))
  const buckets = new Map()
  let sum = 0
  let total = 0

  for (let y = 0; y < height; y += step) {
    const row = topDown ? y : height - 1 - y
    for (let x = 0; x < width; x += step) {
      const index = offset + row * rowSize + x * bytesPerPixel
      if (index + 2 >= buffer.length) continue
      const blue = buffer[index]
      const green = buffer[index + 1]
      const red = buffer[index + 2]
      sum += (red + green + blue) / 3
      total += 1
      const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
  }

  if (total === 0) return { mean: 0, uniform: 1 }
  let max = 0
  for (const count of buckets.values()) if (count > max) max = count
  return { mean: sum / total, uniform: max / total }
}

/** 跑一个子进程并收尾；非零退出时把 stderr 归类成工具错误码。 */
function runCommand(command, argv, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, argv, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolvePromise({
        ok: false,
        stdout,
        stderr,
        error: { ok: false, code: 'CAPTURE_TIMEOUT', message: `${command} 超时（${Math.round(timeoutMs / 1000)}s）` },
      })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, stdout, stderr, error: { ok: false, code: 'CAPTURE_SPAWN_FAILED', message: error.message } })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise({ ok: true, stdout, stderr })
        return
      }
      resolvePromise({ ok: false, stdout, stderr, error: classifyMacFailure(command, code, stderr) })
    })
  })
}

function runCommandSync(command, argv, timeoutMs) {
  const result = spawnSync(command, argv, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  if (result.error) return { ok: false, stdout: result.stdout ?? '', stderr: result.error.message }
  if (result.status !== 0) {
    return { ok: false, stdout: result.stdout ?? '', stderr: result.stderr ?? `退出码 ${result.status}` }
  }
  return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function classifyMacFailure(command, code, stderr) {
  const text = String(stderr ?? '').trim()
  const lower = text.toLowerCase()
  if (lower.includes('does not intersect')) {
    return { ok: false, code: 'RegionOutsideScreen', message: `区域不在任何屏幕内：${text.slice(0, 300)}` }
  }
  if (lower.includes('permission') || lower.includes('denied') || lower.includes('not authorized')) {
    return {
      ok: false,
      code: 'SCREEN_RECORDING_DENIED',
      message: `需要屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕录制，勾选 DeepSeek Harness 后重启应用（${text.slice(0, 300)}）`,
    }
  }
  return {
    ok: false,
    code: 'CAPTURE_FAILED',
    message: `${command} 退出码 ${code}${text === '' ? '' : `：${text.slice(0, 300)}`}`,
  }
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
    backend: config.backend === 'helper' || config.backend === 'powershell' || config.backend === 'screencapture'
      ? config.backend
      : 'auto',
    blankUniformity: Number.isFinite(Number(config.blankUniformity)) ? Number(config.blankUniformity) : 0.995,
    skills: config.skills !== false,
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
