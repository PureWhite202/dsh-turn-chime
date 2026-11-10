/**
 * Apply-time wiring for the right-Sidebar fallback.
 *
 * The map deliberately keeps the main column empty, so the host's
 * `ctx.sidebarRight.openResource` refuses every file link inside a card's
 * drawer ("sidebarRight: no session surface is mounted"). This module finds
 * that controller, feeds the pure wrapper (`sidebar-fallback.ts`) the host
 * callbacks it needs, and lets the plugin's effect lifetime install and
 * remove it. Missing services degrade to a no-op — the map must never fail to
 * load because a host face is absent.
 */
import { installSidebarFallback, type SidebarFallbackDeps, type SidebarRightLike } from './sidebar-fallback.ts'
import { showMapNotice } from './map-state.ts'
import { t } from './i18n.ts'
import type { TalkMapClientContext } from './dsh.ts'

/** Structural check: only an object with both navigation methods is wrappable. */
function isController(value: unknown): value is SidebarRightLike {
  if (typeof value !== 'object' || value === null) return false
  const holder = value as { openResource?: unknown; openTab?: unknown }
  return typeof holder.openResource === 'function' && typeof holder.openTab === 'function'
}

/** The controller as a declared service or through the host's service lookup. */
function controllerOf(ctx: TalkMapClientContext): SidebarRightLike | undefined {
  if (isController(ctx.sidebarRight)) return ctx.sidebarRight
  if (typeof ctx.get === 'function') {
    const found = ctx.get('sidebarRight')
    if (isController(found)) return found
  }
  return undefined
}

/** Host callbacks the fallback uses: workspace roots, the open route, the toast. */
function fallbackDeps(ctx: TalkMapClientContext): SidebarFallbackDeps {
  return {
    resolveCwd: (sessionId) => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
    openPathExternally: async (path) => {
      const remote = ctx.remote
      const open = remote?.session.openWorkspacePath
      if (remote === undefined || typeof open !== 'function') return false
      try {
        const result = await open.call(remote.session, { path })
        return result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === true
      } catch {
        return false
      }
    },
    openUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    notify: showMapNotice,
  }
}

/**
 * Install the fallback for this client's lifetime.
 *
 * @param ctx - the plugin context providing the controller and host callbacks.
 * @returns a restore function the plugin effect calls on unload.
 */
export function installSidebarFallbackOnClient(ctx: TalkMapClientContext): () => void {
  const messages = {
    failed: t('toast.openFallbackFailed'),
    unsupported: t('toast.openFallbackUnsupported'),
  }
  const deps = fallbackDeps(ctx)
  const restores: Array<() => void> = []
  const attach = (service: unknown): void => {
    if (!isController(service)) return
    restores.push(installSidebarFallback(service, deps, messages))
  }

  const direct = controllerOf(ctx)
  if (direct !== undefined) attach(direct)
  else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['sidebarRight'], (scope) => { attach(scope.sidebarRight) })
    } catch {
      /* host without dynamic injection: the host dialog stays as it was */
    }
  }
  return () => { for (const restore of restores.splice(0)) restore() }
}
