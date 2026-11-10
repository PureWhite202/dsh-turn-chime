// 冒烟测试：用假 ctx 走一遍「注册 -> 执行 -> 渲染」，会真的截一张屏。
// 运行：node test/smoke.mjs
// Windows 需要先生成 helper（scripts/build-helper.mjs）；macOS 走系统 screencapture，无需额外依赖。

import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, createScreenshotTool } from '../index.js'
import { analyzeBmp, classifyMacFailure, selectMacWindow } from '../index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'test', '.out')

const savedImages = []
const attachments = {
  async saveImage({ data, mediaType, name }) {
    savedImages.push({ bytes: data.length, mediaType, name })
    return {
      attachmentId: `sha256:${'0'.repeat(64)}`,
      mediaType,
      bytes: data.length,
      width: 100,
      height: 100,
      ...(name === undefined ? {} : { name }),
    }
  },
}

const registered = []
const ctx = {
  tools: { register(definition) { registered.push(definition); return () => {} } },
  effect(factory) { return factory() },
  get(service) { return service === 'attachments' ? attachments : undefined },
}

function fakeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

// 构造 2x2 24bit BMP：三黑一白（底行黑黑、顶行黑白）。
function buildBmp2x2() {
  const rowSize = 8
  const buffer = Buffer.alloc(54 + rowSize * 2)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(2, 18)
  buffer.writeInt32LE(2, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(rowSize * 2, 34)
  // 顶行第二个像素为白色（BGR 顺序），其余为黑。
  buffer.writeUInt8(255, 54 + rowSize + 3)
  buffer.writeUInt8(255, 54 + rowSize + 4)
  buffer.writeUInt8(255, 54 + rowSize + 5)
  return buffer
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  // 1. 注册
  apply(ctx, {})
  assert.equal(registered.length, 1, 'apply 应该注册一个工具')
  const tool = registered[0]
  assert.equal(tool.name, 'screenshot')
  assert.equal(typeof tool.execute, 'function')
  assert.ok(tool.output && typeof tool.output.render === 'function')
  console.log('ok 注册:', tool.name)

  // 1a-bis. 内置技能注册：DSH 的 skills.register 要求 source 是非空字符串。
  // 缺了会抛「loaded skill "x" source must be a string」，整轮启动被标成失败，
  // 技能不会出现在目录里。这里锁住契约，避免以后又退回只传 path。
  {
    const skillSpecs = []
    const skillsCtx = {
      skills: { register(spec) { skillSpecs.push(spec); return () => {} } },
      effect(factory) { return factory() },
    }
    const skillHost = {
      tools: { register() { return () => {} } },
      effect(factory) { return factory() },
      inject(services, cb) {
        if (Array.isArray(services) && services.includes('skills')) cb(skillsCtx)
      },
    }
    apply(skillHost, { skills: true })
    assert.ok(skillSpecs.length >= 1, '应当注册至少一个内置技能')
    for (const spec of skillSpecs) {
      assert.equal(typeof spec.source, 'string', `${spec.name} 的 source 必须是字符串`)
      assert.ok(spec.source.length > 0, `${spec.name} 的 source 不能为空`)
      assert.equal(typeof spec.name, 'string')
      assert.equal(typeof spec.description, 'string')
      assert.ok(spec.content.length > 0, `${spec.name} 的正文不能为空`)
    }
    console.log('ok 内置技能:', skillSpecs.map((s) => `${s.name}(${s.source})`).join(', '))
  }

  // 1b. 纯函数：窗口匹配优先级
  const fakeWindows = [
    {
      id: 425,
      owner: 'Safari浏览器',
      title: 'omdsh-dev/dsh-genui: GenUI for DeepSeek Harness: interactive UI components',
      width: 1400,
      height: 800,
      onscreen: true,
    },
    { id: 181, owner: 'DeepSeek Harness', title: 'DeepSeek Harness', width: 1280, height: 820, onscreen: true },
  ]
  const byOwner = selectMacWindow(fakeWindows, { window: 'DeepSeek Harness' })
  assert.equal(byOwner.ok, true)
  assert.equal(byOwner.window.id, 181, '进程名精确匹配应优先于标题里恰好包含该词的其他窗口')
  const byTitle = selectMacWindow(fakeWindows, { window: 'dsh-genui' })
  assert.equal(byTitle.ok, true)
  assert.equal(byTitle.window.id, 425)
  const byHwnd = selectMacWindow(fakeWindows, { hwnd: 425 })
  assert.equal(byHwnd.ok, true)
  assert.equal(byHwnd.window.id, 425)
  const noMatch = selectMacWindow(fakeWindows, { window: '____nope____' })
  assert.equal(noMatch.ok, false)
  assert.equal(noMatch.code, 'WindowNotFound')
  assert.match(noMatch.message, /可见窗口/)
  console.log('ok 窗口匹配优先级')

  // 1c. 纯函数：越界区域归类成 RegionOutsideScreen
  const outside = classifyMacFailure(
    '/usr/sbin/screencapture',
    1,
    'screencapture: rect (90000.0, 90000.0, 50.0, 50.0) does not intersect any displays',
  )
  assert.equal(outside.code, 'RegionOutsideScreen')
  const denied = classifyMacFailure('/usr/sbin/screencapture', 1, 'screencapture: not authorized to capture screen')
  assert.equal(denied.code, 'SCREEN_RECORDING_DENIED')
  console.log('ok 错误归类')

  // 1d. 纯函数：BMP 统计（2x2，三黑一白 → 亮度 63.75、最大同色占比 0.75）
  const stats = analyzeBmp(buildBmp2x2())
  assert.ok(Math.abs(stats.mean - 63.75) < 0.01, `mean 应约为 63.75，实际 ${stats.mean}`)
  assert.ok(Math.abs(stats.uniform - 0.75) < 0.01, `uniform 应约为 0.75，实际 ${stats.uniform}`)
  console.log('ok BMP 统计')

  // 2. 整屏截图 + 落盘到指定目录
  const value = await tool.execute(
    { target: 'screen', outDir: OUT_DIR, fileName: 'smoke.png', scale: 0.4 },
    fakeExec(ROOT),
  )
  assert.equal(value.ok, true, `整屏截图应成功，实际：${JSON.stringify(value)}`)
  assert.ok(value.path && value.path.endsWith('smoke.png'), 'path 应指向指定文件名')
  assert.ok(value.width > 0 && value.height > 0, '应有宽高')
  assert.equal(value.capture.kind, 'screen')
  console.log(`ok 整屏: ${value.width}x${value.height} ${value.bytes} bytes`)

  // 2b. 区域截图：宽高比应贴合请求的矩形（macOS 的 -R 用点，Windows 用像素，比例一致）
  const regionShot = await tool.execute(
    {
      target: 'region',
      region: { x: 0, y: 0, width: 200, height: 120 },
      save: false,
      scale: 0.5,
    },
    fakeExec(ROOT),
  )
  assert.equal(regionShot.ok, true, `区域截图应成功，实际：${JSON.stringify(regionShot)}`)
  assert.equal(regionShot.capture.kind, 'region')
  assert.ok(regionShot.width > 0 && regionShot.height > 0, '区域截图应有宽高')
  const regionRatio = regionShot.width / regionShot.height
  assert.ok(
    Math.abs(regionRatio - 200 / 120) < 0.1,
    `区域宽高比应接近 5:3，实际 ${regionShot.width}x${regionShot.height}`,
  )
  console.log(`ok 区域: ${regionShot.width}x${regionShot.height}`)

  // 3. 渲染出 image 块
  const blocks = tool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.mediaType, 'image/png')
  assert.ok(savedImages.length >= 1, '应该调用过 attachments.saveImage')
  console.log('ok 渲染: text + image 两个内容块')

  // 4. 相对 outDir 按会话工作目录解析
  const relValue = await tool.execute(
    { target: 'screen', outDir: 'test/.out', fileName: 'relative.png', scale: 0.3 },
    fakeExec(ROOT),
  )
  assert.equal(relValue.ok, true)
  assert.ok(relValue.path.includes(join('test', '.out')), `相对目录应解析到会话 cwd 下，实际 ${relValue.path}`)
  console.log('ok 相对目录:', relValue.path)

  // 5. 找不到窗口时给出候选列表而不是抛错
  const missing = await tool.execute(
    { target: 'window', window: '____definitely-not-a-real-window-title____' },
    fakeExec(ROOT),
  )
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'WindowNotFound')
  assert.match(missing.message, /可见窗口/, '错误信息应附候选窗口标题')
  console.log('ok 窗口不存在: 返回候选列表')

  // 6. save=false 时不落盘
  const unsaved = await tool.execute({ target: 'screen', save: false, scale: 0.25 }, fakeExec(ROOT))
  assert.equal(unsaved.ok, true)
  assert.equal(unsaved.path, undefined, 'save=false 不应有 path')
  console.log('ok save=false: 不落盘')

  console.log('\n全部通过')
}

main().catch((error) => {
  console.error('冒烟测试失败:', error)
  process.exit(1)
})
