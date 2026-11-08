/**
 * The full-screen map surface, registered into 'shell.overlay' (root-scope
 * list slot: the layer is click-through, this entry opts back into pointer
 * events only while open). Closed state renders null so the app underneath
 * stays fully interactive.
 *
 * The map itself never changes shape. A single-clicked card opens its Session
 * in a right-hand drawer that overlays the map edge: the conversation is the
 * host's own embedded occurrence (SessionProvider + the conversation.content
 * Factory), so it stays fully interactive — composer, streaming, approvals —
 * while the board keeps its exact position underneath.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { LocalePref } from '../shared/model.ts'
import type { RootSlotStandardProps, SessionReference } from './dsh.ts'
import { canvas } from './canvas-store.ts'
import { DEFAULT_HOTKEY, hotkeyFromEvent, hotkeyLabel } from './hotkey.ts'
import { activeLocale, LOCALE_CYCLE, subscribeLocale, t } from './i18n.ts'
import { getServices, mapUi, openSessionInMain, persistDrawer, persistedDrawer, useArchivedSessionIds } from './map-state.ts'
import { completions } from './interactions.ts'
import { MapCanvas } from './MapCanvas.tsx'
import { MapErrorBoundary } from './MapErrorBoundary.tsx'
import styles from './talk-map.module.css'

/**
 * Slot kit the runtime injects because this entry declares a session-scoped
 * child slot ('talk-map.chat'): the plain renderSlot binding and the
 * SessionProvider seat used to bind one concrete Session around the drawer.
 */
export interface TalkMapOverlayProps extends RootSlotStandardProps {
  renderSlot?: (name: string, props?: Record<string, unknown>) => React.ReactNode
  SessionProvider?: React.ComponentType<{ session: SessionReference; children?: React.ReactNode }>
}

/** One card whose conversation is open in the drawer. */
interface ChatTarget {
  readonly sessionId: string
  readonly reference: SessionReference
}

/** A card the drawer cannot duplicate: its Conversation is already on screen. */
interface ChatNotice {
  readonly sessionId: string
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function HotkeyButton(): React.JSX.Element {
  const hotkey = useSyncExternalStore(canvas.subscribe, () => canvas.get().global?.hotkey ?? DEFAULT_HOTKEY)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!capturing) return
    const release = mapUi.claimEscape('hotkey-capture')
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(false)
        return
      }
      const captured = hotkeyFromEvent(event)
      if (captured !== null) {
        canvas.patchGlobalNow({ hotkey: captured })
        setCapturing(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      release()
    }
  }, [capturing])

  return (
    <button
      type="button"
      className={styles['hotkeyButton']}
      title={t('hotkey.title')}
      onClick={() => { setCapturing(true) }}
    >
      {capturing ? t('hotkey.capturing') : hotkeyLabel(hotkey)}
    </button>
  )
}

/**
 * Interface language: cycles auto → 中文 → English. 'auto' follows dsh's
 * own <html lang>, which is what every install had before this setting.
 */
function LanguageButton(): React.JSX.Element {
  const pref = useSyncExternalStore(canvas.subscribe, () => canvas.get().global?.locale ?? 'auto')
  const index = LOCALE_CYCLE.indexOf(pref)
  const next: LocalePref = LOCALE_CYCLE[(index + 1) % LOCALE_CYCLE.length] ?? 'auto'
  return (
    <button
      type="button"
      className={styles['langButton']}
      title={t('lang.hint', { current: t(`lang.${pref}`), next: t(`lang.${next}`) })}
      onClick={() => { canvas.patchGlobalNow({ locale: next }) }}
    >
      {t(`lang.${pref}`)}
    </button>
  )
}

/**
 * Session id the main Conversation column is showing right now. The layout's
 * own slot anchors it: a right-sidebar chat or the map drawer can render
 * another conversation occurrence, which the first-match query used to pick.
 */
function mainConversationSessionId(): string | undefined {
  const main = document.querySelector('[data-slot="main.conversation"] [data-conversation-content]')
  const mainId = main?.getAttribute('data-conversation-session')
  if (mainId !== null && mainId !== undefined && mainId !== '') return mainId
  for (const el of document.querySelectorAll('[data-conversation-content]')) {
    if (el.closest('aside') !== null || el.closest('[data-shell-overlay]') !== null) continue
    const sessionId = el.getAttribute('data-conversation-session')
    if (sessionId !== null && sessionId !== '') return sessionId
  }
  return undefined
}

function OpenMapOverlay(props: TalkMapOverlayProps): React.JSX.Element {
  const sessionCount = props.useSessions(state => state.ids.length)
  const [chat, setChat] = useState<ChatTarget | null>(null)
  const [notice, setNotice] = useState<ChatNotice | null>(null)
  const chatRef = useRef<ChatTarget | null>(null)
  /** Session an open request is currently waiting for (newly created ones). */
  const chatWantedRef = useRef<string | undefined>(undefined)
  /**
   * While the drawer shows the Session the main column was showing, the main
   * column is parked on another Session of the same workspace: the host owns
   * exactly one editable composer per Session, so the drawer must be the only
   * occurrence. `original` is restored when the drawer/map closes.
   */
  const swapRef = useRef<{ original: string; parking: string } | null>(null)
  const swapPendingRef = useRef<string | undefined>(undefined)
  const mountedRef = useRef(true)
  const archivedIds = useArchivedSessionIds()
  /**
   * References retained for the drawer, kept until the overlay unmounts.
   * Releasing one while the drawer swaps Sessions makes the host read a
   * retired binding ("Session reference ... is released"), so a switch only
   * moves the visible occurrence; the handles die with the map.
   */
  const retainedRef = useRef(new Map<string, SessionReference>())

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  /**
   * The Session on the main column: the retention feed is authoritative
   * (`retainedBy.mainView`), the layout slot is the fallback, and the runtime's
   * "last opened" field only a last resort.
   */
  const mainSessionId = (): string | undefined => {
    const services = getServices()
    const list = services?.sessions.list.getSnapshot()
    if (list !== undefined) {
      for (const summary of Object.values(list.byId)) {
        if ((summary.retainedBy?.mainView ?? 0) > 0) return summary.id
      }
    }
    return mainConversationSessionId()
  }

  const currentSessionId = (): string | undefined => {
    const main = mainSessionId()
    if (main !== undefined) return main
    const services = getServices()
    return services?.sessions.list.getSnapshot().current
  }

  /**
   * Sessions that can take the main column while the drawer shows the current
   * one. Same workspace first (no workspace switch), then any other Session as
   * a last resort; subagent children cannot open in the main column.
   */
  const findParkingSessions = (sessionId: string): string[] => {
    const services = getServices()
    if (services === undefined) return []
    const list = services.sessions.list.getSnapshot()
    const cwd = list.byId[sessionId]?.cwd
    const archived = new Set(services.workspaces.list?.getSnapshot().archivedSessionIds ?? [])
    const usable = (id: string): boolean => {
      if (id === sessionId || archived.has(id)) return false
      const summary = list.byId[id]
      if (summary === undefined) return false
      if (summary.origin === 'subagent') return false
      return true
    }
    const same: string[] = []
    const other: string[] = []
    for (const id of list.ids) {
      if (!usable(id)) continue
      const summary = list.byId[id]
      if (summary !== undefined && cwd !== undefined && cwd !== '' && summary.cwd === cwd) same.push(id)
      else if (other.length < 3) other.push(id)
    }
    return [...same.slice(0, 4), ...other]
  }

  /** Wait until the main column actually shows `sessionId` (bounded). */
  const waitForMain = (sessionId: string, timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (!mountedRef.current) {
        resolve(false)
        return
      }
      if (mainSessionId() === sessionId) {
        resolve(true)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false)
        return
      }
      window.setTimeout(tick, 50)
    }
    window.setTimeout(tick, 0)
  })

  /**
   * Release the drawer's retained Sessions after the overlay unmounted.
   * Releasing earlier can make the host touch a retired binding.
   */
  const releaseRetained = (): void => {
    const references = [...retainedRef.current.values()]
    retainedRef.current.clear()
    window.setTimeout(() => {
      for (const reference of references) {
        try {
          reference.release()
        } catch {
          // Already released by the host while the drawer unmounted.
        }
      }
    }, 0)
  }

  const closeChatNow = (): void => {
    chatRef.current = null
    chatWantedRef.current = undefined
    setChat(null)
  }

  /**
   * The drawer/map closed: put the original Session back on the main column.
   * The drawer's editor is already unmounted by the time this timer runs, so
   * the main occurrence is again the only editable root for that Session.
   */
  const restoreSwap = (): void => {
    const swap = swapRef.current
    if (swap === null) return
    swapRef.current = null
    window.setTimeout(() => { openSessionInMain(swap.original) }, 0)
  }

  const closeChat = (): void => {
    closeChatNow()
    persistDrawer(undefined)
    restoreSwap()
  }

  /** Retain the card's Session and show it in the drawer (single occurrence). */
  const retainAndShow = useCallback((sessionId: string): void => {
    const services = getServices()
    const retain = services?.sessions.retain
    if (services === undefined || retain === undefined) return
    if (chatRef.current?.sessionId === sessionId || chatWantedRef.current === sessionId) return
    chatWantedRef.current = sessionId

    const show = (): boolean => {
      if (chatWantedRef.current !== sessionId) return true
      let reference = retainedRef.current.get(sessionId)
      if (reference === undefined) {
        try {
          reference = retain.call(services.sessions, sessionId, { source: 'talk-map' })
        } catch {
          return false
        }
        retainedRef.current.set(sessionId, reference)
      }
      chatWantedRef.current = undefined
      chatRef.current = { sessionId, reference }
      setChat({ sessionId, reference })
      persistDrawer(sessionId)
      return true
    }

    if (show()) return

    // A Session created moments ago may not be in the client catalog yet:
    // wait for it to appear, then bind the drawer (bounded retry).
    let stop: (() => void) | undefined
    const timer = setTimeout(() => {
      stop?.()
      stop = undefined
      if (chatWantedRef.current === sessionId) chatWantedRef.current = undefined
    }, 8000)
    const check = (): void => {
      if (stop === undefined) return
      if (show()) {
        stop()
        stop = undefined
        clearTimeout(timer)
      }
    }
    stop = services.sessions.list.subscribe(check)
    check()
  }, [])

  const handleFullOpen = useCallback((sessionId: string): void => {
    // A full open wins over any parked Session: never restore it afterwards,
    // or the double-clicked target would be replaced by the parked one.
    swapPendingRef.current = undefined
    swapRef.current = null
    closeChatNow()
    persistDrawer(undefined)
    setNotice(null)
    mapUi.setOpen(false)
    // The drawer's editor must unmount before the main column mounts the same
    // Session, otherwise the two occurrences collide again.
    window.setTimeout(() => { openSessionInMain(sessionId) }, 0)
  }, [])

  /**
   * A card's drawer. The host owns ONE editable composer root per Session
   * (ui-conversation: "does not support simultaneous editable roots for one
   * Session"), so a card that is already on screen gets the main column
   * parked on another Session of the workspace while the drawer shows it.
   */
  const openChat = useCallback((sessionId: string): void => {
    const services = getServices()
    const retain = services?.sessions.retain
    if (services === undefined) return
    if (retain === undefined) {
      // Hosts without client references keep the original full-open behavior.
      mapUi.setOpen(false)
      openSessionInMain(sessionId)
      return
    }
    if (swapPendingRef.current !== undefined) return
    if (chatRef.current?.sessionId === sessionId) return
    const swap = swapRef.current
    if (swap !== null && sessionId === swap.parking) {
      // The parked Session is the one on screen: it cannot be duplicated.
      closeChatNow()
      setNotice({ sessionId })
      return
    }
    if (currentSessionId() !== sessionId) {
      setNotice(null)
      retainAndShow(sessionId)
      return
    }
    const candidates = findParkingSessions(sessionId)
    if (candidates.length === 0) {
      console.warn('[dsh-talk-map] no Session available to park the main column', { sessionId })
      closeChatNow()
      setNotice({ sessionId })
      return
    }
    closeChatNow()
    setNotice(null)
    swapPendingRef.current = sessionId
    void (async () => {
      for (const parking of candidates) {
        if (!mountedRef.current) return
        swapRef.current = { original: sessionId, parking }
        openSessionInMain(parking)
        const parked = await waitForMain(parking, 1500)
        if (parked) {
          swapPendingRef.current = undefined
          if (!mountedRef.current) return
          retainAndShow(sessionId)
          return
        }
      }
      // Every candidate refused/slowed the main-column switch: restore the
      // original Session and show the honest explanation.
      console.warn('[dsh-talk-map] parking the main column failed', { sessionId, candidates })
      swapPendingRef.current = undefined
      swapRef.current = null
      if (!mountedRef.current) return
      openSessionInMain(sessionId)
      setNotice({ sessionId })
    })()
  }, [retainAndShow])

  /**
   * Click-open parity with the sidebar: opening a finished-but-unread Session
   * clears its green dot. The host clears the unread flag only for the Session
   * the main column shows, so visit it briefly, wait for the status to settle,
   * then put the original Session back before the drawer takes over (two
   * editable occurrences must never overlap).
   */
  const markReadThenOpen = useCallback((sessionId: string): void => {
    const unread = completions.getSnapshot().has(sessionId)
    const original = mainSessionId()
    if (!unread || original === undefined || original === sessionId) {
      openChat(sessionId)
      return
    }
    openSessionInMain(sessionId)
    void (async () => {
      const visited = await waitForMain(sessionId, 1500)
      const started = Date.now()
      while (mountedRef.current && Date.now() - started < 1500 && completions.getSnapshot().has(sessionId)) {
        await new Promise((resolve) => window.setTimeout(resolve, 50))
      }
      if (!mountedRef.current) return
      if (visited) {
        openSessionInMain(original)
        await waitForMain(original, 1500)
      }
      if (!mountedRef.current) return
      openChat(sessionId)
    })()
  }, [openChat])

  /** Archived Sessions reject turns host-side: offer the one-click restore. */
  const unarchiveDrawerSession = useCallback((): void => {
    const services = getServices()
    const unarchive = services?.workspaces.unarchiveSession
    const sessionId = chatRef.current?.sessionId
    if (services === undefined || unarchive === undefined || sessionId === undefined) return
    void (async () => {
      try {
        const result = await unarchive.call(services.workspaces, sessionId)
        if (result !== undefined && result.ok === false) {
          console.warn('[dsh-talk-map] unarchive failed:', result.error)
        }
      } catch (error) {
        console.warn('[dsh-talk-map] unarchive failed:', error)
      }
    })()
  }, [])

  // The drawer is part of the map's long-lived state: restore the Session it
  // was showing when the map last went away. Waiting for the app's own main
  // column first keeps the same-Session parking decision correct.
  useEffect(() => {
    const target = persistedDrawer()
    if (target === undefined) return
    let cancelled = false
    let lastMain: string | undefined
    let stableSince = 0
    const started = Date.now()
    const attempt = (): void => {
      if (cancelled || !mountedRef.current) return
      if (chatRef.current !== null || swapPendingRef.current !== undefined) return
      if (!mapUi.get().open) { persistDrawer(undefined); return }
      const services = getServices()
      if (services === undefined || services.sessions.retain === undefined) { persistDrawer(undefined); return }
      if (services.sessions.list.getSnapshot().byId[target] === undefined) {
        if (Date.now() - started < 2500) { window.setTimeout(attempt, 200); return }
        persistDrawer(undefined)
        return
      }
      // Let the app restore its own main column first: whether the drawer may
      // open directly or has to park the main view depends on what is shown.
      const main = mainConversationSessionId()
      if (main !== undefined) {
        if (lastMain !== main) {
          lastMain = main
          stableSince = Date.now()
        } else if (Date.now() - stableSince < 150) {
          window.setTimeout(attempt, 80)
          return
        }
      } else if (Date.now() - started < 3000) {
        window.setTimeout(attempt, 120)
        return
      }
      openChat(target)
    }
    const timer = window.setTimeout(attempt, 200)
    return () => { cancelled = true; window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // An inner surface (draft card, spawn preview) claims Esc for itself.
      if (mapUi.escapeClaimed()) return
      event.stopPropagation()
      // The drawer sits above the map: close it before the map itself.
      if (notice !== null) {
        setNotice(null)
        return
      }
      if (chatRef.current !== null) {
        closeChat()
        return
      }
      mapUi.setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => { window.removeEventListener('keydown', onKeyDown, { capture: true }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice])

  // The overlay unmounts on close (Esc, ✕, or a double-clicked full open):
  // drop the retained Session with it so its history stream does not leak, and
  // put a parked main Session back once the drawer's editor has unmounted.
  useEffect(() => () => {
    chatRef.current = null
    chatWantedRef.current = undefined
    releaseRetained()
    const swap = swapRef.current
    swapRef.current = null
    swapPendingRef.current = undefined
    if (swap !== null) {
      window.setTimeout(() => { openSessionInMain(swap.original) }, 0)
    }
  }, [])

  const drawerSessionId = chat?.sessionId ?? notice?.sessionId
  const chatTitle = props.useSessions(
    state => (drawerSessionId === undefined ? undefined : state.byId[drawerSessionId]?.displayTitle),
  ) ?? ''

  const drawer = notice !== null
    ? (
        <aside className={styles['chatDrawer']} aria-label={t('map.chat')}>
          <div className={styles['chatDrawerHeader']}>
            <span className={styles['chatDrawerTitle']} title={chatTitle}>{chatTitle}</span>
            <span className={styles['chatDrawerSpace']} />
            <button
              type="button"
              className={styles['chatDrawerClose']}
              title={t('map.closeChat')}
              aria-label={t('map.closeChat')}
              onClick={() => { setNotice(null) }}
            >
              <CloseIcon />
            </button>
          </div>
          <div className={styles['chatDrawerNotice']}>
            <p className={styles['chatDrawerNoticeText']}>{t('map.sameSessionHint')}</p>
            <button
              type="button"
              className={styles['chatDrawerNoticeButton']}
              onClick={() => { setNotice(null); mapUi.setOpen(false) }}
            >
              {t('map.showMain')}
            </button>
          </div>
        </aside>
      )
    : chat !== null && props.SessionProvider !== undefined && props.renderSlot !== undefined
      ? (
        <aside className={styles['chatDrawer']} aria-label={t('map.chat')}>
          <div className={styles['chatDrawerHeader']}>
            <span className={styles['chatDrawerTitle']} title={chatTitle}>{chatTitle}</span>
            <span className={styles['chatDrawerSpace']} />
            <button
              type="button"
              className={styles['chatDrawerClose']}
              title={t('map.closeChat')}
              aria-label={t('map.closeChat')}
              onClick={closeChat}
            >
              <CloseIcon />
            </button>
          </div>
          {archivedIds.has(chat.sessionId)
            ? (
                <div className={styles['chatDrawerArchived']}>
                  <span className={styles['chatDrawerArchivedText']}>{t('map.archivedHint')}</span>
                  <button
                    type="button"
                    className={styles['chatDrawerArchivedButton']}
                    onClick={unarchiveDrawerSession}
                  >
                    {t('map.unarchive')}
                  </button>
                </div>
              )
            : null}
          <div className={styles['chatDrawerBody']}>
            <props.SessionProvider session={chat.reference}>
              {props.renderSlot('talk-map.chat', { sessionId: chat.sessionId })}
            </props.SessionProvider>
          </div>
        </aside>
      )
    : null

  return (
    <div className={styles['overlay']} lang={activeLocale()} role="dialog" aria-label={t('map.title')}>
      <div className={styles['header']}>
        <span className={styles['headerTitle']}>{t('map.title')}</span>
        <span className={styles['headerBadge']}>{sessionCount} {t('map.sessions')}</span>
        <span className={styles['headerSpace']} />
        <LanguageButton />
        <HotkeyButton />
        <button
          type="button"
          className={styles['closeButton']}
          title={t('map.close')}
          aria-label={t('map.close')}
          onClick={() => { mapUi.setOpen(false) }}
        >
          <CloseIcon />
        </button>
      </div>
      <div className={styles['body']}>
        <MapErrorBoundary>
          <MapCanvas {...props} onOpenChat={markReadThenOpen} onOpenSession={handleFullOpen} />
          {drawer}
        </MapErrorBoundary>
      </div>
    </div>
  )
}

export function MapOverlay(props: TalkMapOverlayProps): React.JSX.Element | null {
  const open = useSyncExternalStore(mapUi.subscribe, () => mapUi.get().open)
  // Subscribing here re-renders the whole overlay on a language switch;
  // MapCanvas re-keys its own memos so the React-Flow nodes follow.
  useSyncExternalStore(subscribeLocale, activeLocale, activeLocale)
  if (!open) return null
  return <OpenMapOverlay {...props} />
}
