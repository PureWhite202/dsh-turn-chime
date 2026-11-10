/**
 * dsh-talk-map, browser half: one sidebar footer action (toggle) plus one
 * shell.overlay entry (the map itself). Both ride ctx.slots.inject, so the
 * registrations wait for their slots to exist and unwind on plugin unload.
 *
 * Failure policy: apply() must never throw — the web shell fails the whole
 * boot when a plugin apply throws, and an external plugin must not take the
 * GUI down (policy proven by dsh-plugin-market).
 */
import type { TalkMapClientContext } from './dsh.ts'
import { canvas } from './canvas-store.ts'
import { DEFAULT_HOTKEY, hotkeyMatches } from './hotkey.ts'
import { attachServices, mapUi, persistedMapOpen, showMapNotice } from './map-state.ts'
import { interactions } from './interactions.ts'
import { ChatPanel } from './ChatPanel.tsx'
import { MapOverlay } from './MapOverlay.tsx'
import { MapToggleButton } from './MapToggleButton.tsx'
import { installSidebarFallbackOnClient } from './sidebar-fallback-wire.ts'
import { t } from './i18n.ts'

export const name = 'dsh-talk-map-local'
export const inject = [
  'slots',
  'sessions',
  'workspaces',
  'connection',
  'uiSession',
  'uiWorkspace',
  'remote',
  'remote.session',
  'remote.workspace',
  'remote.agentPresets',
  'fileUpload',
  'fileDrag',
]

let applied = false

export function apply(ctx: TalkMapClientContext): void {
  // A duplicated client injection (module factory executed twice in one page
  // lifetime) would otherwise register a second button and overlay.
  if (applied) return
  applied = true
  ctx.effect(() => () => { applied = false }, 'dsh-talk-map: apply claim')

  try {
    attachServices({
      sessions: ctx.sessions,
      workspaces: ctx.workspaces,
      connection: ctx.connection,
      fileUpload: ctx.fileUpload,
      fileDrag: ctx.fileDrag,
      ...(ctx.remote !== undefined ? { remote: ctx.remote } : {}),
      ...(ctx.uiWorkspace !== undefined ? { uiWorkspace: ctx.uiWorkspace } : {}),
    })
    // Pending approvals/questions ride the host's own Session-status store;
    // without ui-session (older host) the map simply shows the old badge.
    interactions.attach(ctx.uiSession?.sessionStatus)
    ctx.effect(() => () => { attachServices(undefined); interactions.attach(undefined) }, 'dsh-talk-map: services')

    // File links inside a card's drawer go through the host's right-Sidebar
    // controller, which refuses every open while the map keeps the main column
    // empty ("sidebarRight: no session surface is mounted") and paints a modal.
    // Open those files through the desktop instead; other failures stay as-is.
    ctx.effect(() => installSidebarFallbackOnClient(ctx, {
      notify: showMapNotice,
      messages: {
        failed: t('toast.openFallbackFailed'),
        unsupported: t('toast.openFallbackUnsupported'),
      },
    }), 'dsh-talk-map: sidebar file fallback')

    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'talk-map',
      order: 10,
      label: () => t('map.toggle'),
    }, MapToggleButton))

    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'talk-map',
      order: 100,
      label: () => t('map.title'),
      // A session-scoped child slot: declaring it makes the runtime hand the
      // overlay the renderSlot/SessionProvider kit the right-hand chat drawer
      // needs to render one concrete Session's conversation (the same kit
      // ui-subagent uses for embedded conversations in the right Sidebar).
      children: { 'talk-map.chat': { kind: 'single', scope: 'session' } },
    }, MapOverlay))

    ctx.slots.inject('talk-map.chat', () => ctx.slots.register({
      name: 'talk-map.chat',
    }, ChatPanel))

    // Toggle hotkey (default ⌥F, user-configurable in the map header).
    // preventDefault stops macOS from typing the dead character (ƒ etc.)
    // into a focused composer. State loads early so the custom binding is
    // live before the map is first opened.
    canvas.ensureLoaded()
    // The map is a long-lived surface: restoring its open flag keeps the
    // canvas (and the saved camera) in place across page reloads / desktop
    // restarts instead of dropping the user back into the main view. Wait for
    // the map data so the overlay mounts with its saved viewport.
    if (persistedMapOpen()) {
      ctx.effect(() => {
        const openNow = (): void => { if (persistedMapOpen()) mapUi.setOpen(true) }
        const phase = canvas.get().phase
        if (phase === 'ready' || phase === 'error') {
          openNow()
          return () => undefined
        }
        const unsubscribe = canvas.subscribe(() => {
          const nextPhase = canvas.get().phase
          if (nextPhase === 'ready' || nextPhase === 'error') {
            unsubscribe()
            openNow()
          }
        })
        return () => { unsubscribe() }
      }, 'dsh-talk-map: restore open state')
    }
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        const hotkey = canvas.get().global?.hotkey ?? DEFAULT_HOTKEY
        if (hotkeyMatches(event, hotkey)) {
          event.preventDefault()
          event.stopPropagation()
          mapUi.toggle()
        }
      }
      window.addEventListener('keydown', onKeyDown, { capture: true })
      return () => { window.removeEventListener('keydown', onKeyDown, { capture: true }) }
    }, 'dsh-talk-map: toggle hotkey')
  } catch (error) {
    console.error('[dsh-talk-map] client apply failed:', error)
  }
}
