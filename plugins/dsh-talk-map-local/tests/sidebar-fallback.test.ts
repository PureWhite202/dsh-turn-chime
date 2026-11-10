import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isNoSessionSurfaceError,
  parseFileAddress,
  resolveTargetPath,
  installSidebarFallback,
  type SidebarRightLike,
} from '../src/client/sidebar-fallback.ts'

/** A stand-in for the host controller: records calls, throws on demand. */
function fakeSidebar(handler: () => void): SidebarRightLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    openResource(address: string): void {
      calls.push(`resource:${address}`)
      handler()
    },
    openTab(kind: string): void {
      calls.push(`tab:${kind}`)
      handler()
    },
  }
}

function noSurface(): never {
  throw new Error('sidebarRight: no session surface is mounted')
}

/** Deps that record how the fallback was reached. */
function fakeDeps(overrides: Partial<{
  resolveCwd: (sessionId: string) => string | undefined
  openPathExternally: (path: string) => Promise<boolean>
  openUrl: (url: string) => void
  notify: (message: string) => void
}> = {}) {
  const opened: string[] = []
  const urls: string[] = []
  const notices: string[] = []
  return {
    opened,
    urls,
    notices,
    deps: {
      resolveCwd: overrides.resolveCwd ?? (() => '/home/u/project'),
      openPathExternally: overrides.openPathExternally
        ?? (async (path: string) => { opened.push(path); return true }),
      openUrl: overrides.openUrl ?? ((url: string) => { urls.push(url) }),
      notify: overrides.notify ?? ((message: string) => { notices.push(message) }),
    },
    messages: { failed: 'FAILED', unsupported: 'UNSUPPORTED' },
  }
}

const FILE_ADDRESS = 'dsh-resource://file/session/session-1/src/a.ts'

test('the host "no session surface" error is recognised by its message', () => {
  assert.equal(isNoSessionSurfaceError(new Error('sidebarRight: no session surface is mounted')), true)
  assert.equal(isNoSessionSurfaceError('sidebarRight: no session surface is mounted'), true)
  assert.equal(isNoSessionSurfaceError(new Error('sidebarRight: tab "t" has no committed occurrence')), false)
  assert.equal(isNoSessionSurfaceError(new Error('boom')), false)
  assert.equal(isNoSessionSurfaceError(undefined), false)
})

test('a workspace-relative file address yields its session and path', () => {
  assert.deepEqual(parseFileAddress(FILE_ADDRESS), { sessionId: 'session-1', path: 'src/a.ts' })
})

test('an encoded path decodes segment by segment', () => {
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/session/session-1/docs/%E4%B8%AD%E6%96%87%20a.md'),
    { sessionId: 'session-1', path: 'docs/中文 a.md' },
  )
})

test('an absolute path keeps its leading separator after the session segment', () => {
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/session/session-1//etc/hosts'),
    { sessionId: 'session-1', path: '/etc/hosts' },
  )
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/session/session-1/C:/Users/me/a%20b.md'),
    { sessionId: 'session-1', path: 'C:/Users/me/a b.md' },
  )
})

test('addresses of other resource types are not file targets', () => {
  assert.equal(parseFileAddress('dsh-resource://plan/session/session-1/plan.md'), null)
  assert.equal(parseFileAddress('dsh-resource://file/session/session-1/'), null)
  assert.equal(parseFileAddress('not-an-address'), null)
})

test('a relative path joins the session workspace with its separator spelling', () => {
  assert.equal(resolveTargetPath('C:\\proj', 'src/a.ts'), 'C:\\proj\\src\\a.ts')
  assert.equal(resolveTargetPath('/home/u/p', 'src/a.ts'), '/home/u/p/src/a.ts')
  assert.equal(resolveTargetPath('/home/u/p/', './src/a.ts'), '/home/u/p/src/a.ts')
})

test('an absolute path passes through without a workspace root', () => {
  assert.equal(resolveTargetPath(undefined, 'D:/other/x.ts'), 'D:/other/x.ts')
  assert.equal(resolveTargetPath('C:\\proj', '/etc/hosts'), '/etc/hosts')
  assert.equal(resolveTargetPath(undefined, 'src/a.ts'), undefined)
})

test('a file link that fails for lack of a surface opens through the OS instead', async () => {
  const sidebar = fakeSidebar(noSurface)
  const fakes = fakeDeps({ resolveCwd: () => '/home/u/project' })
  const restore = installSidebarFallback(sidebar, fakes.deps, fakes.messages)

  assert.equal(sidebar.openResource(FILE_ADDRESS), undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(fakes.opened, ['/home/u/project/src/a.ts'])
  assert.deepEqual(fakes.notices, [])
  restore()
})

test('an unrelated navigation failure is not swallowed', () => {
  const sidebar = fakeSidebar(() => { throw new Error('boom') })
  const fakes = fakeDeps()
  const restore = installSidebarFallback(sidebar, fakes.deps, fakes.messages)

  assert.throws(() => sidebar.openResource(FILE_ADDRESS), /boom/)
  assert.deepEqual(fakes.opened, [])
  restore()
})

test('a browser tab that fails for lack of a surface opens in a new window', () => {
  const sidebar = fakeSidebar(noSurface)
  const fakes = fakeDeps()
  const restore = installSidebarFallback(sidebar, fakes.deps, fakes.messages)

  // The controller records the kind, then throws before drawing.
  const tab = sidebar as unknown as { openTab(kind: string, options?: unknown): void }
  tab.openTab('browser', { params: { url: 'https://example.com/x' } })
  assert.deepEqual(fakes.urls, ['https://example.com/x'])
  restore()
})

test('an external open that the host refuses falls back to a notice', async () => {
  const sidebar = fakeSidebar(noSurface)
  const fakes = fakeDeps({ openPathExternally: async () => false })
  const restore = installSidebarFallback(sidebar, fakes.deps, fakes.messages)

  sidebar.openResource(FILE_ADDRESS)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(fakes.notices, ['FAILED'])
  restore()
})

test('a non-file resource that has no surface reports instead of throwing', () => {
  const sidebar = fakeSidebar(noSurface)
  const fakes = fakeDeps()
  const restore = installSidebarFallback(sidebar, fakes.deps, fakes.messages)

  assert.equal(sidebar.openResource('dsh-resource://plan/session/session-1/p.md'), undefined)
  assert.deepEqual(fakes.notices, ['UNSUPPORTED'])
  restore()
})

test('restoring hands the controller back untouched', () => {
  const sidebar = fakeSidebar(noSurface)
  const originalResource = sidebar.openResource
  const originalTab = sidebar.openTab
  const fakes = fakeDeps()

  const restore = installSidebarFallback(sidebar, fakes.deps, fakes.messages)
  assert.notEqual(sidebar.openResource, originalResource)
  restore()
  assert.equal(sidebar.openResource, originalResource)
  assert.equal(sidebar.openTab, originalTab)
})

test('installing twice keeps one wrapper', async () => {
  const sidebar = fakeSidebar(noSurface)
  const fakes = fakeDeps()
  const restoreFirst = installSidebarFallback(sidebar, fakes.deps, fakes.messages)
  const restoreSecond = installSidebarFallback(sidebar, fakes.deps, fakes.messages)

  sidebar.openResource(FILE_ADDRESS)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(fakes.opened, ['/home/u/project/src/a.ts'])
  restoreSecond()
  restoreFirst()
})
