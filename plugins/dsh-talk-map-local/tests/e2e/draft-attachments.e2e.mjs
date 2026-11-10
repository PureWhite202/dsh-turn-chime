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

/** The one-pixel PNG every image scenario uses. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg=='

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
  const mapButton = page.getByRole('button', { name: /Talk Map|对话地图/ }).first()
  await mapButton.waitFor({ state: 'visible', timeout: 30000 })
  await mapButton.click()
  await page.waitForSelector('[data-talk-map-canvas]', { timeout: 10000 })
}

async function openDraft(page) {
  if (await page.locator('[data-talk-map-draft]').count()) return
  await page.locator('[data-talk-map-canvas]').dblclick({ position: { x: 500, y: 300 } })
  await page.waitForSelector('[data-talk-map-draft]', { timeout: 8000 })
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
