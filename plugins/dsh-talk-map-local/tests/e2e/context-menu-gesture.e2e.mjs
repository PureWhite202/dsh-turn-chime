#!/usr/bin/env node
/**
 * Isolated E2E for the board's right-button gestures.
 *
 * The contract:
 *   - a plain right click (even with a pixel or two of jitter) opens the
 *     context menu at the press point;
 *   - a right-DRAG pans the viewport and never opens the context menu —
 *     not while the pointer is down, not after the release;
 *   - the drag gesture leaves no state behind: a right click afterwards
 *     still opens the menu.
 *
 * Why this file exists: Chromium raises `contextmenu` on the right-button
 * PRESS, before the pointer has moved, so a "did it travel?" check made at
 * that moment can never see the drag — the menu used to open on every right
 * press, including the start of a right-drag pan.
 *
 * What it does:
 *   1. builds + packs this plugin (the exact artifact the profile installs);
 *   2. creates a throwaway DSH_HOME / `e2e` profile (base + web-app + this
 *      plugin), copies the desktop credentials so the fresh profile does not
 *      block on the preview/sign-in dialog, and boots a private `dsh web` on
 *      an OS-assigned port;
 *   3. drives the real map with Playwright and asserts the gestures above;
 *   4. tears the host down and deletes the temp home.
 *
 * Preconditions: Node 24, `pnpm` and `dsh` on PATH, Playwright installed
 * globally (or PLAYWRIGHT_MODULE pointing at it), and the desktop DSH home's
 * `.credentials.yaml`. Run from the plugin directory:
 *
 *   node tests/e2e/context-menu-gesture.e2e.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..', '..')
const artifactsDir = join(here, 'artifacts')

function loadPlaywright() {
  const candidates = []
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE)
  candidates.push('playwright')
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    candidates.push(join(globalRoot, 'playwright'))
  } catch { /* npm unavailable — try the rest */ }
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch { /* next candidate */ }
  }
  throw new Error('playwright not found; install it globally or set PLAYWRIGHT_MODULE to the module directory')
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr || stdout}`))
    })
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

async function startHost(home) {
  const env = { ...process.env, DSH_HOME: home }
  for (const key of ['DSH_WEB_URL', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL']) {
    delete env[key]
  }
  const child = spawn('dsh', ['--profile', 'e2e', '--port', '0', '--no-open', '--host', '127.0.0.1'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return await new Promise((resolvePromise, reject) => {
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`dsh web did not print a URL within 30s:\n${output}`))
    }, 30000)
    const onData = (chunk) => {
      output += String(chunk)
      const match = output.match(/(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
      if (match !== null && !settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise({ child, url: match[1], output: () => output })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`dsh web exited (${code}) before printing a URL:\n${output}`))
    })
  })
}

async function waitForHostExit(child) {
  if (child.exitCode !== null) return
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    child.kill('SIGTERM')
  })
}

async function prepareProfile(home, tgz) {
  await run('dsh', ['plugin', '--profile', 'e2e', 'add', `file:${tgz}`], {
    env: { ...process.env, DSH_HOME: home },
  })
  const profileFile = join(home, 'profiles', 'e2e', 'package.json')
  const profile = JSON.parse(await readFile(profileFile, 'utf8'))
  profile.dsh.profile.bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dsh-talk-map-local',
  ]
  await writeFile(profileFile, `${JSON.stringify(profile, null, 2)}\n`)
}

/** A fresh profile opens the preview notice; acknowledge it so the shell is usable. */
async function dismissPreviewNotice(page) {
  const button = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  if (await button.count() === 0) return
  await button.click()
  await page.waitForTimeout(600)
}

async function openMap(page) {
  if (await page.locator('[data-talk-map-canvas]').count()) return
  const mapButton = page.getByRole('button', { name: /Talk Map|对话地图/ }).first()
  await mapButton.waitFor({ state: 'visible', timeout: 30000 })
  await mapButton.click()
  await page.waitForSelector('[data-talk-map-canvas]', { timeout: 10000 })
  await page.waitForTimeout(500)
}

async function menuCount(page) {
  return await page.locator('[role="menu"]').count()
}

async function viewportTransform(page) {
  return await page.locator('.react-flow__viewport').evaluate(element => element.style.transform)
}

/** Right click without moving: the menu must appear once the button is up. */
async function scenarioPlainRightClick(page, point) {
  const menu = page.locator('[role="menu"]')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  await menu.waitFor({ state: 'visible', timeout: 3000 })
  assert(await page.getByRole('menuitem').count() > 0, 'the plain right click shows menu items')

  // Anchored at the PRESS point, not the release point. The menu positions
  // itself inside the canvas wrapper, so compare in wrapper coordinates.
  const box = await menu.boundingBox()
  const canvas = await page.locator('[data-talk-map-canvas]').boundingBox()
  assert(box !== null && canvas !== null, 'menu and canvas boxes are measurable')
  const x = Math.round(box.x - canvas.x)
  const y = Math.round(box.y - canvas.y)
  const pressX = Math.round(point.x - canvas.x)
  const pressY = Math.round(point.y - canvas.y)
  assert(Math.abs(x - pressX) <= 6 && Math.abs(y - pressY) <= 6, `menu anchored at the press point (menu ${x},${y} vs press ${pressX},${pressY})`)

  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached', timeout: 3000 })
}

/** A jittery click is still a click: a few pixels must not swallow the menu. */
async function scenarioJitterRightClick(page, point) {
  const menu = page.locator('[role="menu"]')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(point.x + 3, point.y + 2)
  await page.mouse.up({ button: 'right' })
  await menu.waitFor({ state: 'visible', timeout: 3000 })
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached', timeout: 3000 })
}

/** A right drag is a pan: no menu while the button is down, none on release. */
async function scenarioRightDrag(page, from, delta) {
  const before = await viewportTransform(page)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(from.x + delta.x, from.y + delta.y, { steps: 10 })
  assert(await menuCount(page) === 0, 'no menu while a right-drag is in flight')
  await page.mouse.up({ button: 'right' })
  await page.waitForTimeout(350)
  assert(await menuCount(page) === 0, 'no menu after a right-drag release')
  const after = await viewportTransform(page)
  assert(after !== before, `the right-drag still pans (viewport ${before} -> ${after})`)
}

/** The drag must not leave a sticky gesture behind. */
async function scenarioRightClickAfterDrag(page, point) {
  const menu = page.locator('[role="menu"]')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  await menu.waitFor({ state: 'visible', timeout: 3000 })
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached', timeout: 3000 })
}

async function scenario(name, fn) {
  process.stdout.write(`… ${name}\n`)
  await fn()
  process.stdout.write(`✔ ${name}\n`)
}

async function main() {
  const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
  const tgz = join(pluginDir, `dsh-talk-map-local-${pkg.version}.tgz`)

  process.stdout.write('… build + pack\n')
  await run('pnpm', ['run', 'build'], { cwd: pluginDir })
  await run('pnpm', ['pack', '--ignore-scripts'], { cwd: pluginDir })
  assert(existsSync(tgz), `pack did not produce ${tgz}`)

  const home = await mkdtemp(join(tmpdir(), 'talk-map-right-click-e2e-'))
  let host
  let browser
  try {
    await prepareProfile(home, tgz)
    const credentials = join(homedir(), '.dsh', '.credentials.yaml')
    assert(existsSync(credentials), `missing ${credentials}; the fresh profile would block on "Get started"`)
    await copyFile(credentials, join(home, '.credentials.yaml'))

    const started = await startHost(home)
    host = started.child
    process.stdout.write(`  host: ${started.url.split('?')[0]}\n`)

    const { chromium } = loadPlaywright()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error))
    await page.goto(started.url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)

    await dismissPreviewNotice(page)
    await openMap(page)
    assert(await page.locator('.react-flow__node').count() === 0, 'the fresh board starts empty')
    const canvas = await page.locator('[data-talk-map-canvas]').boundingBox()
    assert(canvas !== null, 'the canvas is measurable')
    // Viewport coordinates; the anchor assertion converts them to the
    // wrapper's coordinate space, where the menu positions itself.
    const point = {
      x: Math.round(canvas.x + canvas.width / 2 + 160),
      y: Math.round(canvas.y + canvas.height / 2 + 40),
    }

    await scenario('plain right click opens the menu at the press point', async () => {
      await scenarioPlainRightClick(page, point)
    })

    await scenario('a jittery right click still opens the menu', async () => {
      await scenarioJitterRightClick(page, { x: point.x + 40, y: point.y + 30 })
    })

    await scenario('a right drag pans without opening the menu', async () => {
      await scenarioRightDrag(page, { x: point.x - 120, y: point.y - 60 }, { x: 140, y: 90 })
    })

    await scenario('a right click after a drag still opens the menu', async () => {
      await scenarioRightClickAfterDrag(page, { x: point.x + 10, y: point.y + 10 })
    })

    assert(pageErrors.length === 0, `no page errors escaped: ${pageErrors.map(String).join('; ')}`)

    process.stdout.write('\nAll context-menu gesture scenarios passed.\n')
  } catch (error) {
    if (browser !== undefined) {
      try {
        const pages = browser.contexts()[0]?.pages() ?? []
        if (pages[0] !== undefined) {
          await pages[0].screenshot({ path: join(artifactsDir, `right-click-failure-${Date.now()}.png`) })
        }
      } catch { /* best effort */ }
    }
    throw error
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
    if (host !== undefined) await waitForHostExit(host)
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
