/**
 * Apply-time wiring for the right-Sidebar fallback.
 *
 * The map deliberately keeps the main column empty, so the host's
 * `ctx.sidebarRight.openResource` refuses every file link inside a card's
 * drawer ("sidebarRight: no session surface is mounted"). This module finds
 * that controller, feeds the pure wrapper (`sidebar-fallback.ts`) the host
 * callbacks it needs, and lets the plugin's effect lifetime install and
 * remove it.
 *
 * Everything here is best-effort: a missing service, a throwing lookup, or a
 * sealed controller must leave the rest of the plugin's apply() running, so
 * every step is contained. Copy and the toast sink are injected by the caller
 * (the plugin entry) so this module carries no host-UI imports.
 */
import {
  installSidebarFallback,
  type SidebarFallbackDeps,
  type SidebarFallbackMessages,
  type SidebarRightLike,
} from './sidebar-fallback.ts'
import type { TalkMapClientContext } from './dsh.ts'

/** The plugin-facing half of the fallback: copy plus the toast sink. */
export interface ClientFallbackHooks {
  /** Localized copy for the two fallback outcomes. */
  messages: SidebarFallbackMessages
  /** Where the fallback reports (the map's bottom toast). */
  notify(message: string): void
}

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

/** Host callbacks the fallback uses: workspace roots, the open route, a tab. */
function fallbackDeps(ctx: TalkMapClientContext, hooks: ClientFallbackHooks): SidebarFallbackDeps {
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
    openUrl: (url) => {
      const host = (globalThis as { window?: { open?: (url: string, target?: string, features?: string) => unknown } }).window
      host?.open?.(url, '_blank', 'noopener,noreferrer')
    },
    notify: hooks.notify,
  }
}

/**
 * Install the fallback for this client's lifetime, never throwing.
 *
 * @param ctx - the plugin context providing the controller and host callbacks.
 * @param hooks - localized copy and the toast sink.
 * @returns a restore function the plugin effect calls on unload.
 */
export function installSidebarFallbackOnClient(ctx: TalkMapClientContext, hooks: ClientFallbackHooks): () => void {
  const restores: Array<() => void> = []
  const attach = (service: unknown): void => {
    if (!isController(service)) return
    try {
      restores.push(installSidebarFallback(service, fallbackDeps(ctx, hooks), hooks.messages))
    } catch (error) {
      console.warn('[dsh-talk-map] sidebar fallback could not wrap the controller:', error)
    }
  }

  try {
    const direct = controllerOf(ctx)
    if (direct !== undefined) attach(direct)
    else if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['sidebarRight'], (scope) => { attach(scope.sidebarRight) })
      } catch {
        /* host without dynamic injection: the host dialog stays as it was */
      }
    }
  } catch (error) {
    console.warn('[dsh-talk-map] sidebar fallback not installed:', error)
  }

  return () => { for (const restore of restores.splice(0)) restore() }
}
