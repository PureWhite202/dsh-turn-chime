// 冒烟测试：用假 ctx 走一遍「注册 -> 执行 -> 渲染」，会真的截一张屏。
// 运行：node test/smoke.mjs（先跑 scripts/build-helper.mjs 确保 helper 存在）

import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, createScreenshotTool } from '../index.js'

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
