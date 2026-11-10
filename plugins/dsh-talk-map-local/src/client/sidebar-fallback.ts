/**
 * The host opens a file reference through the *global* right-sidebar
 * controller (`ctx.sidebarRight.openResource`), which only works while a
 * Session is on screen (`SidebarRightController.require()`). The map keeps the
 * main column empty on purpose — one editable composer root per Session — so
 * every file link inside a card's drawer throws
 * "sidebarRight: no session surface is mounted" and the host paints its
 * "无法打开文件" dialog.
 *
 * This module wraps the controller's navigation methods for exactly that
 * failure: a file address opens through the host's own "open path" route
 * (system default application), a browser page opens in a new window, and
 * anything else is reported through the map's toast instead of a dead dialog.
 * Every other error is rethrown untouched.
 *
 * Pure by design (no imports, no DOM): the caller supplies the controller and
 * the host callbacks, so `node --test` can exercise the behaviour directly.
 */

/** Fragment of the host error thrown when no Session surface is mounted. */
const NO_SURFACE_FRAGMENT = 'no session surface is mounted'

/** The address scheme prefix every file resource carries. */
const FILE_PREFIX = 'dsh-resource://file/session/'

/** Navigation methods the wrapper replaces (subset of the host controller). */
export interface SidebarRightLike {
  openResource(address: string, options?: unknown): void
  openTab(kind: string, options?: unknown): void
}

/** Host callbacks the fallback needs; injected so this module stays testable. */
export interface SidebarFallbackDeps {
  /** Workspace root of the Session an address belongs to. */
  resolveCwd(sessionId: string): string | undefined
  /** Ask the host to open one absolute path in its default application. */
  openPathExternally(path: string): Promise<boolean>
  /** Open one page outside the app (browser tab). */
  openUrl(url: string): void
  /** Surface a short message in the map's toast. */
  notify(message: string): void
}

/** Localized messages for the two fallback outcomes. */
export interface SidebarFallbackMessages {
  failed: string
  unsupported: string
}

/** Wrappers already installed, so a second apply() cannot nest them. */
const installed = new WeakSet<SidebarRightLike['openResource']>()

/** Whether `error` is the host's "no Session surface" refusal (and nothing else). */
export function isNoSessionSurfaceError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : undefined
  return message !== undefined && message.includes(NO_SURFACE_FRAGMENT)
}

/**
 * Read a `dsh-resource://file/session/<session>/<path>` address.
 *
 * The host encodes one segment at a time, so decoding works segment by
 * segment; an absolute target keeps its leading separator (the address then
 * carries two slashes after the Session id). Other resource types and empty
 * paths are not file targets.
 *
 * @param address - the resource address the host controller was given.
 * @returns the owning Session and the decoded path, or `null`.
 */
export function parseFileAddress(address: string): { sessionId: string; path: string } | null {
  if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return null
  const rest = address.slice(FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  let sessionId: string
  let path: string
  try {
    sessionId = decodeURIComponent(rest.slice(0, slash))
    const query = rest.slice(slash + 1).split('?')[0] ?? ''
    path = query.split('/').map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    return null
  }
  if (path === '') return null
  return { sessionId, path }
}

/** Path spellings the host accepts as absolute (POSIX, Windows drive, UNC). */
function isAbsoluteTarget(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

/**
 * Resolve a decoded address path against its Session workspace, the same way
 * the host does before it reads a file.
 *
 * @param cwd - the Session's workspace root, when known.
 * @param path - absolute or workspace-relative path in either separator spelling.
 * @returns the absolute path, or `undefined` when a relative path has no root.
 */
export function resolveTargetPath(cwd: string | undefined, path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  if (isAbsoluteTarget(normalized)) return normalized
  if (cwd === undefined || cwd === '') return undefined
  const root = cwd.replace(/[/\\]+$/, '')
  const windows = /\\/.test(cwd)
  const trimmed = normalized.replace(/^(?:\.?\/)+/, '')
  const relative = windows ? trimmed.replace(/\//g, '\\') : trimmed
  return `${root}${windows ? '\\' : '/'}${relative}`
}

/** Read `options.params.url` off a browser-tab open (the host's own shape). */
function tabUrl(options: unknown): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const params = (options as { params?: unknown }).params
  if (typeof params !== 'object' || params === null) return undefined
  const url = (params as { url?: unknown }).url
  return typeof url === 'string' && url !== '' ? url : undefined
}

/**
 * Wrap the host controller's navigation methods with the fallbacks above.
 *
 * The wrapper only intervenes when the host refuses for lack of a Session
 * surface; everything else keeps the host's behaviour.
 *
 * @param sidebarRight - the shared `ctx.sidebarRight` controller instance.
 * @param deps - host callbacks the fallback uses.
 * @param messages - localized failure copy.
 * @returns a restore function putting the original methods back.
 */
export function installSidebarFallback(
  sidebarRight: SidebarRightLike,
  deps: SidebarFallbackDeps,
  messages: SidebarFallbackMessages,
): () => void {
  const holder = sidebarRight as unknown as Record<string, unknown>
  const currentResource = holder.openResource
  if (typeof currentResource !== 'function' || installed.has(currentResource as SidebarRightLike['openResource'])) {
    return () => {}
  }
  const originalResource = currentResource as SidebarRightLike['openResource']
  const originalTab = holder.openTab as SidebarRightLike['openTab']
  const ownResource = Object.prototype.hasOwnProperty.call(sidebarRight, 'openResource')
  const ownTab = Object.prototype.hasOwnProperty.call(sidebarRight, 'openTab')

  const fallbackResource = (address: string): void => {
    const target = parseFileAddress(address)
    if (target === null) {
      deps.notify(messages.unsupported)
      return
    }
    const absolute = resolveTargetPath(deps.resolveCwd(target.sessionId), target.path)
    if (absolute === undefined) {
      deps.notify(messages.failed)
      return
    }
    void deps.openPathExternally(absolute).then(
      (opened) => { if (!opened) deps.notify(messages.failed) },
      () => { deps.notify(messages.failed) },
    )
  }

  const wrappedResource = function (this: unknown, address: string, options?: unknown): void {
    try {
      originalResource.call(sidebarRight, address, options)
    } catch (error) {
      if (!isNoSessionSurfaceError(error)) throw error
      fallbackResource(address)
    }
  }
  const wrappedTab = function (this: unknown, kind: string, options?: unknown): void {
    try {
      originalTab.call(sidebarRight, kind, options)
    } catch (error) {
      if (!isNoSessionSurfaceError(error)) throw error
      const url = tabUrl(options)
      if (kind === 'browser' && url !== undefined) {
        deps.openUrl(url)
        return
      }
      deps.notify(messages.unsupported)
    }
  }
  installed.add(wrappedResource)

  holder.openResource = wrappedResource
  holder.openTab = wrappedTab

  return () => {
    if (holder.openResource === wrappedResource) {
      if (ownResource) holder.openResource = originalResource
      else delete holder.openResource
    }
    if (holder.openTab === wrappedTab) {
      if (ownTab) holder.openTab = originalTab
      else delete holder.openTab
    }
  }
}
