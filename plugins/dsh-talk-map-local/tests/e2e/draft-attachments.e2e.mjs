#!/usr/bin/env node
/**
 * Isolated E2E for the talk-map draft-card attachment intake.
 *
 * What it does, end to end:
 *   1. builds + packs this plugin (the exact artifact the profile installs);
 *   2. creates a throwaway DSH_HOME and a profile that loads base + web-app +
 *      this plugin, then boots a private `dsh web` on an OS-assigned port;
 *   3. drives the map with Playwright: opens the right-click draft, pastes an
 *      image, pastes text+image, drops a PDF, simulates a drawer-image drag,
 *      and removes an attachment;
 *   4. tears the host down and deletes the temp home.
 *
 * Preconditions: Node 24, pnpm on PATH, a `dsh` CLI on PATH, `playwright`
 * installed globally (or PLAYWRIGHT_MODULE pointing at it), and the desktop
 * DSH home's `.credentials.yaml` (the fresh profile needs a signed-in model
 * so the app does not block on the "Get started" dialog).
 *
 * Run from the plugin directory: `node tests/e2e/draft-attachments.e2e.mjs`
 */
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..', '..')
const artifactsDir = join(here, 'artifacts')

/** A valid, fully decodable red 64×64 PNG (the Host normalizes with sharp). */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAu0lEQVR4nOXOMREAMAgAsZeI/8NLKyMDQ/a0M++ydEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QEsHtHRASwe0dEBLB7R0QPuw07JKas17MgAAAABJRU5ErkJggg=='

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
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
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

async function poll(fn, message, timeoutMs = 10000, intervalMs = 100) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`TIMEOUT: ${message}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs))
  }
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

async function openMap(page) {
  if (await page.locator('[data-talk-map-canvas]').count()) return
  const mapButton = page.getByRole('button', { name: /Talk Map|对话地图/ }).first()
  await mapButton.waitFor({ state: 'visible', timeout: 30000 })
  await mapButton.click()
  await page.waitForSelector('[data-talk-map-canvas]', { timeout: 10000 })
}

async function closeDrawer(page) {
  const drawer = page.locator('aside[aria-label="Conversation panel"], aside[aria-label="会话窗口"]')
  if (!(await drawer.count())) return
  const close = drawer.first().getByRole('button', { name: /Close conversation panel|关闭会话窗口/ })
  if (await close.count()) await close.first().click()
  await drawer.first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
}

/**
 * Open the draft box through the pane context menu. A plain double-click used
 * to open it, but that gesture now creates the conversation outright (see the
 * 'double-click creates a conversation' scenario), so the form lives behind
 * the second menu entry.
 */
async function openDraft(page, position = { x: 500, y: 300 }) {
  if (await page.locator('[data-talk-map-draft]').count()) return
  // Retry a few known-empty points: a right-click on a card or frame opens
  // that node's own menu (no draft entry), and the drawer covers the right
  // edge of the canvas.
  const attempts = [position, { x: 700, y: 200 }, { x: 400, y: 700 }, { x: 200, y: 500 }]
  for (const point of attempts) {
    await openMap(page)
    await closeDrawer(page)
    await page.locator('[data-talk-map-canvas]').click({ button: 'right', position: point })
    const entry = page.getByRole('menuitem', { name: /New conversation \(fill in first\)|新对话（先填写）/ })
    try {
      await entry.waitFor({ state: 'visible', timeout: 2000 })
    } catch {
      // Right-click landed on a card/frame (its menu has no draft entry).
      await page.keyboard.press('Escape')
      continue
    }
    await entry.click()
    try {
      await page.waitForSelector('[data-talk-map-draft]', { timeout: 3000 })
      return
    } catch { /* the panel closed on its own: try the next point */ }
  }
  throw new Error('could not open a draft card')
}

async function closeDraft(page) {
  if (!(await page.locator('[data-talk-map-draft]').count())) return
  await page.keyboard.press('Escape')
  await page.locator('[data-talk-map-draft]').waitFor({ state: 'detached', timeout: 8000 })
}

/** Dispatch a paste with one PNG; `text` fills text/plain. Returns false when preventDefault won. */
async function pastePng(page, text) {
  return await page.evaluate(({ b64, text: clipboardText }) => {
    const textarea = document.querySelector('[data-talk-map-draft] textarea')
    if (textarea === null) throw new Error('draft textarea missing')
    const bytes = Uint8Array.from(atob(b64), character => character.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }))
    transfer.setData('text/plain', clipboardText)
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
    return textarea.dispatchEvent(event)
  }, { b64: PNG_B64, text })
}

/** Paste a file declared as image/png whose bytes are not an image. */
async function pasteCorruptPng(page) {
  return await page.evaluate(() => {
    const textarea = document.querySelector('[data-talk-map-draft] textarea')
    if (textarea === null) throw new Error('draft textarea missing')
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([8, 9, 10, 11])], 'not-an-image.png', { type: 'image/png' }))
    transfer.setData('text/plain', '')
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
    return textarea.dispatchEvent(event)
  })
}

/** Dispatch a drop on the draft card. `data` merges into the DataTransfer. */
async function dropOnDraft(page, files, data) {
  return await page.evaluate(({ files: payload, data: extra }) => {
    const target = document.querySelector('[data-talk-map-draft]')
    if (target === null) throw new Error('draft card missing')
    const transfer = new DataTransfer()
    for (const file of payload) {
      const bytes = Uint8Array.from(atob(file.b64), character => character.charCodeAt(0))
      transfer.items.add(new File([bytes], file.name, { type: file.type }))
    }
    for (const [type, value] of Object.entries(extra ?? {})) transfer.setData(type, value)
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
    return target.dispatchEvent(event)
  }, { files, data })
}

/** Drop a large generically-typed file without shipping its bytes through the driver. */
async function dropBigFile(page, sizeBytes) {
  return await page.evaluate((size) => {
    const target = document.querySelector('[data-talk-map-draft]')
    if (target === null) throw new Error('draft card missing')
    const bytes = new Uint8Array(size)
    bytes.fill(7)
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'big.bin', { type: 'application/octet-stream' }))
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
    return target.dispatchEvent(event)
  }, sizeBytes)
}

async function clickSend(page) {
  const button = page.locator('[data-talk-map-draft]').getByRole('button', { name: /^(Send|发送)$/ })
  assert((await button.count()) === 1, 'one Send button in the draft')
  assert(await button.isEnabled(), 'Send is enabled')
  await button.click()
}

async function sessionCards(page) {
  return await page.locator('.react-flow__node-sessionCard').count()
}

async function waitForDrawer(page) {
  const drawer = page.locator('aside[aria-label="Conversation panel"], aside[aria-label="会话窗口"]')
  await drawer.first().waitFor({ state: 'visible', timeout: 20000 })
  return drawer.first()
}

async function uploadPng(page) {
  return await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), character => character.charCodeAt(0))
    const response = await fetch('/talk-map/images/upload', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Blob([bytes], { type: 'image/png' }),
    })
    if (!response.ok) throw new Error(`image upload failed: ${response.status}`)
    return (await response.json()).src
  }, PNG_B64)
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

  const home = await mkdtemp(join(tmpdir(), 'talk-map-e2e-'))
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

    const continueButton = page.getByRole('button', { name: 'Continue' })
    if (await continueButton.count()) {
      await continueButton.first().click()
      await page.waitForTimeout(800)
    }
    await openMap(page)

    await scenario('macOS traffic-light clearance', async () => {
      const header = page.locator('[data-talk-map-header]')
      const base = await header.boundingBox()
      assert(base !== null, 'map header is visible')
      const previousPlatform = await page.evaluate(() => document.documentElement.getAttribute('data-platform'))
      await page.evaluate(() => { document.documentElement.setAttribute('data-platform', 'darwin') })
      await page.waitForTimeout(80)
      const darwin = await header.boundingBox()
      assert(darwin !== null && darwin.y >= 48, `darwin header clears the traffic lights (y=${darwin?.y})`)
      await page.evaluate((platform) => {
        if (platform === null) document.documentElement.removeAttribute('data-platform')
        else document.documentElement.setAttribute('data-platform', platform)
      }, previousPlatform)
    })

    await scenario('double-click creates a conversation without the draft box', async () => {
      await openMap(page)
      await closeDrawer(page)
      const draftBefore = await page.locator('[data-talk-map-draft]').count()
      assert(draftBefore === 0, 'no draft box is open before the double-click')
      await page.locator('[data-talk-map-canvas]').dblclick({ position: { x: 520, y: 320 } })
      // The form must never show up on this path.
      await page.waitForTimeout(1200)
      assert((await page.locator('[data-talk-map-draft]').count()) === 0, 'double-click must not open the draft box')
      // The newborn conversation opens in the map's right-hand drawer.
      const drawer = page.locator('aside[aria-label="Conversation panel"], aside[aria-label="会话窗口"]')
      await drawer.first().waitFor({ state: 'visible', timeout: 20000 })
      await closeDrawer(page)

      // Shift is the escape hatch back to the form: it must still open the
      // draft box instead of creating yet another conversation.
      await openMap(page)
      await page.locator('[data-talk-map-canvas]').dblclick({ position: { x: 300, y: 620 }, modifiers: ['Shift'] })
      await page.waitForSelector('[data-talk-map-draft]', { timeout: 5000 })
      await closeDraft(page)
    })

    await scenario('paste image only', async () => {
      await openDraft(page)
      const notPrevented = await pastePng(page, '')
      assert(notPrevented === false, 'image-only paste should preventDefault')
      await poll(async () => (await page.locator('[data-talk-map-attachment="image"]').count()) === 1, 'image attachment appears')
      const preview = page.locator('[data-talk-map-attachment="image"] img')
      assert((await preview.count()) === 1, 'image preview rendered')
      const src = await preview.first().getAttribute('src')
      assert(src !== null && src.startsWith('blob:'), `preview is a blob URL (got ${src})`)
    })

    await scenario('paste text + image keeps text', async () => {
      await closeDraft(page)
      await openDraft(page)
      await page.locator('[data-talk-map-draft] textarea').fill('hello image')
      const notPrevented = await pastePng(page, 'hello image')
      assert(notPrevented === true, 'text+image paste must not preventDefault')
      await poll(async () => (await page.locator('[data-talk-map-attachment="image"]').count()) === 1, 'image attachment appears')
      assert((await page.locator('[data-talk-map-draft] textarea').inputValue()) === 'hello image', 'text stays in the textarea')
    })

    await scenario('drop a generic file', async () => {
      await closeDraft(page)
      await openDraft(page)
      const before = await page.locator('.react-flow__node-imageNode').count()
      const prevented = await dropOnDraft(page, [
        { b64: Buffer.from('%PDF-1.4\n% test\n').toString('base64'), name: 'report.pdf', type: 'application/pdf' },
      ], {})
      assert(prevented === false, 'drop should be owned by the draft (preventDefault)')
      await poll(async () => (await page.locator('[data-talk-map-attachment="file"]').count()) === 1, 'file attachment appears')
      assert((await page.locator('[data-talk-map-draft]').innerText()).includes('report.pdf'), 'file card shows the name')
      assert((await page.locator('.react-flow__node-imageNode').count()) === before, 'no canvas image node created')
    })

    await scenario('drawer image source lands in the draft', async () => {
      await closeDraft(page)
      await openDraft(page)
      const src = await uploadPng(page)
      const before = await page.locator('.react-flow__node-imageNode').count()
      const prevented = await dropOnDraft(page, [], {
        'application/x-talk-map-image': JSON.stringify({ src, title: 'drawer image' }),
      })
      assert(prevented === false, 'drawer image drop should be owned by the draft')
      await poll(async () => (await page.locator('[data-talk-map-attachment="image"]').count()) === 1, 'fetched drawer image attachment appears')
      assert((await page.locator('.react-flow__node-imageNode').count()) === before, 'drawer drop did not create a canvas image node')
    })

    await scenario('remove an attachment', async () => {
      const remove = page.locator('[data-talk-map-attachment="image"] button')
      assert((await remove.count()) === 1, 'one remove button')
      await remove.first().click({ force: true })
      await poll(async () => (await page.locator('[data-talk-map-attachment]').count()) === 0, 'attachment removed')
    })

    await scenario('send an image-only draft', async () => {
      const before = await sessionCards(page)
      const notPrevented = await pastePng(page, '')
      assert(notPrevented === false, 'image-only paste should preventDefault')
      await poll(async () => (await page.locator('[data-talk-map-attachment="image"]').count()) === 1, 'image attachment appears')
      await clickSend(page)
      await page.locator('[data-talk-map-draft]').waitFor({ state: 'detached', timeout: 30000 })
      await poll(async () => (await sessionCards(page)) === before + 1, 'new session card appears')
      const drawer = await waitForDrawer(page)
      await poll(async () => (await drawer.locator('img').count()) > 0, 'drawer shows the sent image', 30000)
    })

    await scenario('send a file-only draft (no text)', async () => {
      await openDraft(page, { x: 300, y: 550 })
      const before = await sessionCards(page)
      const prevented = await dropOnDraft(page, [
        { b64: Buffer.from('%PDF-1.4\n% test\n').toString('base64'), name: 'report.pdf', type: 'application/pdf' },
      ], {})
      assert(prevented === false, 'drop should be owned by the draft')
      await poll(async () => (await page.locator('[data-talk-map-attachment="file"]').count()) === 1, 'file attachment appears')
      await clickSend(page)
      await page.locator('[data-talk-map-draft]').waitFor({ state: 'detached', timeout: 30000 })
      await poll(async () => (await sessionCards(page)) === before + 1, 'second session card appears')
      const drawer = await waitForDrawer(page)
      await poll(async () => (await drawer.innerText()).includes('report.pdf'), 'drawer shows the file name', 30000)
    })

    await scenario('host refusal keeps the draft', async () => {
      await openDraft(page, { x: 300, y: 300 })
      const before = await sessionCards(page)
      await pasteCorruptPng(page)
      await poll(async () => (await page.locator('[data-talk-map-attachment="image"]').count()) === 1, 'corrupt image attachment appears')
      await clickSend(page)
      await poll(async () => /upload failed|上传失败/i.test(await page.locator('[data-talk-map-draft]').innerText()), 'upload error is shown', 30000)
      await page.waitForTimeout(500)
      assert((await page.locator('[data-talk-map-draft]').count()) === 1, 'draft survives the refusal')
      assert((await sessionCards(page)) === before, 'no session card on refusal')
    })

    await scenario('Escape during upload closes cleanly', async () => {
      await closeDraft(page)
      await closeDrawer(page)
      await openDraft(page, { x: 1000, y: 400 })
      const before = await sessionCards(page)
      const prevented = await dropBigFile(page, 200 * 1024 * 1024)
      assert(prevented === false, 'big file drop is owned by the draft')
      await poll(async () => (await page.locator('[data-talk-map-attachment="file"]').count()) === 1, 'big file attachment appears')
      await clickSend(page)
      // The attachment rail is frozen while the send is in flight.
      await pastePng(page, '')
      await page.waitForTimeout(20)
      assert((await page.locator('[data-talk-map-attachment]').count()) === 1, 'intake is ignored while sending')
      await page.keyboard.press('Escape')
      await page.locator('[data-talk-map-draft]').waitFor({ state: 'detached', timeout: 10000 })
      await page.waitForTimeout(3000)
      assert((await sessionCards(page)) === before, 'aborting a send leaves no session card')
    })

    await scenario('send still works after an aborted draft', async () => {
      await closeDrawer(page)
      await openDraft(page, { x: 1100, y: 650 })
      const before = await sessionCards(page)
      await page.locator('[data-talk-map-draft] textarea').fill('after abort')
      await clickSend(page)
      await page.locator('[data-talk-map-draft]').waitFor({ state: 'detached', timeout: 30000 })
      await poll(async () => (await sessionCards(page)) === before + 1, 'post-abort send creates a session card')
    })

    // Regression: React Flow's default nodeClickDistance (0) swallows the
    // card's click after ANY pointer travel between press and release, so a
    // trackpad's few-pixel drift made a click do nothing until clicked again.
    // The board now tolerates 5px; the drawer must switch on both cards.
    await scenario('a jittery card click switches the drawer', async () => {
      await openMap(page)
      await closeDrawer(page)
      const cards = page.locator('.react-flow__node-sessionCard')
      const total = await cards.count()
      assert(total >= 2, `need two cards, have ${total}`)
      const drawer = page.locator('aside[aria-label="Conversation panel"], aside[aria-label="会话窗口"]').first()

      // The drawer covers the right edge: pick the two left-most cards so the
      // second click cannot land on the open drawer.
      const candidates = []
      for (let index = 0; index < total; index += 1) {
        const node = cards.nth(index)
        const box = await node.boundingBox()
        if (box === null) continue
        candidates.push({ index, box, title: (await node.locator('[class*="cardTitle"]').innerText()).trim() })
      }
      candidates.sort((left, right) => left.box.x - right.box.x)
      const targets = candidates.slice(0, 2)
      assert(targets.length === 2, 'two measurable cards')

      const clickWithJitter = async (target) => {
        await page.mouse.move(target.box.x + target.box.width / 2, target.box.y + 22)
        await page.mouse.down()
        await page.mouse.move(target.box.x + target.box.width / 2 + 3, target.box.y + 24)
        await page.mouse.up()
        await drawer.waitFor({ state: 'visible', timeout: 5000 })
        await poll(async () => {
          const shown = await drawer.locator('[class*="chatDrawerTitle"]').innerText().catch(() => '')
          return shown.trim() === target.title
        }, `drawer shows the jitter-clicked card (${target.title})`, 5000)
      }

      await clickWithJitter(targets[0])
      await clickWithJitter(targets[1])
      await page.keyboard.press('Escape')
    })

    assert(pageErrors.length === 0, `page errors: ${pageErrors.map(error => error.message).join(' | ')}`)
    process.stdout.write('\nAll draft-attachment intake scenarios passed.\n')
  } catch (error) {
    await mkdir(artifactsDir, { recursive: true })
    const shot = join(artifactsDir, `failure-${Date.now()}.png`)
    if (browser !== undefined) {
      const pages = browser.contexts().flatMap(context => context.pages())
      if (pages[0] !== undefined) await pages[0].screenshot({ path: shot }).catch(() => {})
    }
    process.stderr.write(`\nE2E FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
    if (existsSync(shot)) process.stderr.write(`screenshot: ${shot}\n`)
    process.exitCode = 1
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
    if (host !== undefined) {
      process.stdout.write('… stopping host\n')
      await waitForHostExit(host)
    }
    await rm(home, { recursive: true, force: true })
  }
}

await main()
