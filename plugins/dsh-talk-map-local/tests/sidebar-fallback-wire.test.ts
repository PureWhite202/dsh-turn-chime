import test from 'node:test'
import assert from 'node:assert/strict'
import { installSidebarFallbackOnClient } from '../src/client/sidebar-fallback-wire.ts'
import type { TalkMapClientContext } from '../src/client/dsh.ts'

const FILE_ADDRESS = 'dsh-resource://file/session/session-1/src/a.ts'
const NO_SURFACE = 'sidebarRight: no session surface is mounted'

interface Hooks {
  messages: { failed: string; unsupported: string }
  notify: (message: string) => void
}

function hooks(notices: string[]): Hooks {
  return {
    messages: { failed: 'FAILED', unsupported: 'UNSUPPORTED' },
    notify: (message: string) => { notices.push(message) },
  }
}

/** A context with one workspace Session and a recording host open route. */
function contextWith(opened: string[], extra: Record<string, unknown> = {}): TalkMapClientContext {
  return {
    sessions: {
      list: {
        getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { cwd: '/home/u/project' } } }),
        subscribe: () => () => {},
      },
    },
    remote: {
      session: {
        openWorkspacePath: async (payload: { path: string }) => {
          opened.push(payload.path)
          return { ok: true }
        },
      },
    },
    ...extra,
  } as unknown as TalkMapClientContext
}

interface FakeController {
  openResource(address: string, options?: unknown): void
  openTab(kind: string, options?: unknown): void
}

/** A stand-in for the host controller: every navigation is refused outright. */
function throwingController(): FakeController {
  return {
    openResource(): void { throw new Error(NO_SURFACE) },
    openTab(): void { throw new Error(NO_SURFACE) },
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a file link refused for lack of a surface opens through the host route', async () => {
  const opened: string[] = []
  const notices: string[] = []
  const controller = throwingController()
  const restore = installSidebarFallbackOnClient(
    contextWith(opened, { sidebarRight: controller }),
    hooks(notices),
  )

  controller.openResource(FILE_ADDRESS)
  await tick()

  assert.deepEqual(opened, ['/home/u/project/src/a.ts'])
  assert.deepEqual(notices, [])
  restore()
})

test('a browser tab refused for lack of a surface opens a window', () => {
  const opened: string[] = []
  const notices: string[] = []
  const urls: string[] = []
  const controller = throwingController()
  const originalWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { open: (url: string) => { urls.push(url) } }
  try {
    const restore = installSidebarFallbackOnClient(
      contextWith(opened, { sidebarRight: controller }),
      hooks(notices),
    )
    controller.openTab('browser', { params: { url: 'https://example.com/x' } })
    assert.deepEqual(urls, ['https://example.com/x'])
    assert.deepEqual(notices, [])
    restore()
  } finally {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

test('a refused host open reports the injected failure message', async () => {
  const notices: string[] = []
  const controller = throwingController()
  const ctx = contextWith([], {
    remote: { session: { openWorkspacePath: async () => ({ ok: false }) } },
    sidebarRight: controller,
  })
  const restore = installSidebarFallbackOnClient(ctx, hooks(notices))

  controller.openResource(FILE_ADDRESS)
  await tick()

  assert.deepEqual(notices, ['FAILED'])
  restore()
})

test('a host without the sidebar controller installs nothing and never throws', () => {
  const opened: string[] = []
  const notices: string[] = []
  const restore = installSidebarFallbackOnClient(contextWith(opened), hooks(notices))
  assert.equal(typeof restore, 'function')
  assert.doesNotThrow(() => restore())
})

test('a throwing service lookup does not break the plugin apply', () => {
  const opened: string[] = []
  const notices: string[] = []
  const ctx = contextWith(opened, { get: () => { throw new Error('service lookup exploded') } })
  assert.doesNotThrow(() => installSidebarFallbackOnClient(ctx, hooks(notices)))
})

test('a frozen controller is skipped instead of failing the install', () => {
  const opened: string[] = []
  const notices: string[] = []
  const frozen = Object.freeze({
    openResource(): void { throw new Error(NO_SURFACE) },
    openTab(): void { throw new Error(NO_SURFACE) },
  })
  const ctx = contextWith(opened, { sidebarRight: frozen })
  assert.doesNotThrow(() => installSidebarFallbackOnClient(ctx, hooks(notices)))
})
