// 编译截图 helper（build/dshtool-capture.exe）。
//
// 为什么自己编译而不是发布 exe：
//   - 只依赖 Windows 自带的 .NET Framework 4.x 编译器（csc.exe），不引入打包链；
//   - 4.6KB 的 exe 每次截图 ~0.2s，比 PowerShell 子进程的 ~1.5s 快 7 倍；
//   - 源码可见，避免仓库里放二进制。
//
// 用法：node scripts/build-helper.mjs [--force]

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

if (process.platform !== 'win32') {
  console.log(`跳过：当前平台 ${process.platform} 不需要编译 Windows helper（macOS 走系统 screencapture）。`)
  process.exit(0)
}

const SRC = join(ROOT, 'native', 'Capture.cs')
const OUT = join(ROOT, 'build', 'dshtool-capture.exe')
const force = process.argv.includes('--force')

function findCsc() {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  for (const suite of ['Framework64', 'Framework']) {
    const candidate = join(windir, 'Microsoft.NET', suite, 'v4.0.30319', 'csc.exe')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

if (!existsSync(SRC)) {
  console.error(`缺少源码：${SRC}`)
  process.exit(1)
}

if (!force && existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SRC).mtimeMs) {
  console.log(`已是最新：${OUT}`)
  process.exit(0)
}

const csc = findCsc()
if (csc === undefined) {
  console.error('找不到 csc.exe：需要 .NET Framework 4.x（Windows 10/11 默认自带）。')
  console.error('没有编译器时插件会退到 PowerShell 兜底（仅整屏、约 1.5s/次）。')
  process.exit(2)
}

mkdirSync(dirname(OUT), { recursive: true })
console.log(`编译 ${SRC}`)
console.log(`  -> ${OUT}`)

// 注意：csc 对正斜杠的源文件路径会解析错误，必须传 Windows 反斜杠路径。
const result = spawnSync(csc, [
  '/nologo',
  '/target:exe',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  `/out:${OUT}`,
  SRC,
], { windowsHide: true, stdio: 'inherit', timeout: 120000 })

if (result.error !== undefined) {
  console.error(`编译失败：${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`编译失败，csc 退出码 ${result.status}`)
  process.exit(result.status ?? 1)
}

console.log(`完成：${statSync(OUT).size} 字节`)
