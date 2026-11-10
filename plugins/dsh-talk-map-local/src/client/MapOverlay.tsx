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
  /** The notice's 「refresh main view」 retry is in flight. */
  const [retrying, setRetrying] = useState(false)
  const chatRef = useRef<ChatTarget | null>(null)
  const drawerBodyRef = useRef<HTMLDivElement | null>(null)
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
  /**
   * While the map is open the main column is kept empty: the host owns one
   * editable composer root per Session, and the drawer must be the only place
   * a Conversation renders. `clearMain` is the host's own "close the visible
   * Session" path; `clearedSessionRef` remembers what to put back on close.
   */
  const mainClearedRef = useRef(false)
  const clearedSessionRef = useRef<string | undefined>(undefined)
  /** True during the plugin's own short visit of a Session in the main column
   *  (the host clears an unread dot only for the Session the main column
   *  shows); the background re-clear must not fight that visit. */
  const visitingRef = useRef(false)
  const archivedIds = useArchivedSessionIds()
  /**
   * References retained for the drawer, kept until the overlay unmounts.
   * Releasing one while the drawer swaps Sessions makes the host read a
   * retired binding ("Session reference ... is released"), so a switch only
   * moves the visible occurrence; the handles die with the map.
   */
  const retainedRef = useRef(new Map<string, SessionReference>())

  /**
   * Close the Session the main column shows (host-internal `clearMain`, the
   * same call the host makes when the visible Session is archived). Returns
   * false when the host has no such method, so callers can keep the legacy
   * parking path.
   */
  const clearMainNow = useCallback((): boolean => {
    const ui = getServices()?.uiWorkspace
    if (ui?.clearMain === undefined) return false
    try {
      ui.clearMain()
      mainClearedRef.current = true
      return true
    } catch (error) {
      console.warn('[dsh-talk-map] clearing the main column failed:', error)
      return false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    // The map owns the conversation surface while it is open: close whatever
    // the main column was showing, so a card's drawer never competes with a
    // second editable occurrence of the same Session.
    const before = mainSessionId()
    if (before !== undefined && clearMainNow()) clearedSessionRef.current = before
    return () => { mountedRef.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The app restores its own main column after the overlay mounts (a reload
  // with the map already open), and can also open a Session on its own. While
  // the map is up the main column stays empty: re-clear whatever appears,
  // except during the plugin's own short unread-clearing visit.
  useEffect(() => {
    const ui = getServices()?.uiWorkspace
    if (ui?.clearMain === undefined) return
    const list = getServices()?.sessions.list
    if (list === undefined) return
    const check = (): void => {
      if (!mountedRef.current || visitingRef.current) return
      const current = mainSessionId()
      if (current === undefined) return
      if (clearedSessionRef.current === undefined) clearedSessionRef.current = current
      clearMainNow()
    }
    return list.subscribe(check)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Drag images out of the drawer onto the board: the inline <img> and the
  // file attachment rows carry their URL through the dataTransfer; the map's
  // drop handler uploads the bytes and creates an image node.
  useEffect(() => {
    const body = drawerBodyRef.current
    if (body === null) return
    const onDragStart = (event: DragEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const image = target.closest('img')
      if (image !== null) {
        const src = image.getAttribute('src')
        if (src === null || src === '') return
        event.dataTransfer?.setData('application/x-talk-map-image', JSON.stringify({ src, title: image.getAttribute('alt') ?? '' }))
        event.dataTransfer?.setData('text/uri-list', src)
        return
      }
      const link = target.closest('a[href]')
      if (link === null) return
      const href = link.getAttribute('href') ?? ''
      const name = (link.textContent ?? '').trim()
      if (!/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(href) && !/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) return
      event.dataTransfer?.setData('application/x-talk-map-image', JSON.stringify({ src: href, title: name }))
      event.dataTransfer?.setData('text/uri-list', href)
    }
    body.addEventListener('dragstart', onDragStart, true)
    return () => { body.removeEventListener('dragstart', onDragStart, true) }
  }, [chat?.sessionId])

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
    // A full open wins over any parked or pre-map Session: never restore it
    // afterwards, or the double-clicked target would be replaced.
    swapPendingRef.current = undefined
    swapRef.current = null
    clearedSessionRef.current = undefined
    closeChatNow()
    persistDrawer(undefined)
    setNotice(null)
    mapUi.setOpen(false)
    // The drawer's editor must unmount before the main column mounts the same
    // Session, otherwise the two occurrences collide again.
    window.setTimeout(() => { openSessionInMain(sessionId) }, 0)
  }, [])

  /**
   * Park the main column on a candidate Session, then show `sessionId` in the
   * drawer. Shared by the automatic open path and the notice's manual retry.
   */
  const parkAndShow = useCallback(async (sessionId: string, candidates: string[]): Promise<void> => {
    closeChatNow()
    setNotice(null)
    swapPendingRef.current = sessionId
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
  }, [retainAndShow])

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
    if (mainClearedRef.current) {
      // No main-column occurrence exists while the map is up: the drawer is
      // always safe to render the card's Conversation.
      setNotice(null)
      retainAndShow(sessionId)
      return
    }
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
    void parkAndShow(sessionId, candidates)
  }, [parkAndShow, retainAndShow])

  /**
   * The notice's manual escape hatch: the parking may have lost a race with
   * the Session list loading (the "偶现" notice). Re-read the current list and
   * retry the same switch; if nothing usable appeared we keep the honest
   * notice instead of inventing a Session.
   */
  const retryParking = useCallback((sessionId: string): void => {
    if (retrying || swapPendingRef.current !== undefined) return
    const candidates = findParkingSessions(sessionId)
    if (candidates.length === 0) return
    setRetrying(true)
    void parkAndShow(sessionId, candidates).finally(() => {
      if (mountedRef.current) setRetrying(false)
    })
  }, [parkAndShow, retrying])

  /**
   * Click-open parity with the sidebar: opening a finished-but-unread Session
   * clears its green dot. The host clears the unread flag only for the Session
   * the main column shows, so visit it briefly, wait for the status to settle,
   * then put the original Session back before the drawer takes over (two
   * editable occurrences must never overlap).
   */
  const markReadThenOpen = useCallback((sessionId: string): void => {
    const unread = completions.getSnapshot().has(sessionId)
    if (!unread) {
      openChat(sessionId)
      return
    }
    if (mainClearedRef.current) {
      // The map keeps the main column empty: visit the Session just long
      // enough for the host to clear its unread dot, then give the column back
      // to the map before the drawer mounts the same Conversation.
      visitingRef.current = true
      openSessionInMain(sessionId)
      void (async () => {
        const visited = await waitForMain(sessionId, 1500)
        const started = Date.now()
        while (mountedRef.current && Date.now() - started < 1500 && completions.getSnapshot().has(sessionId)) {
          await new Promise((resolve) => window.setTimeout(resolve, 50))
        }
        visitingRef.current = false
        if (!mountedRef.current) return
        if (visited) clearMainNow()
        openChat(sessionId)
      })()
      return
    }
    const original = mainSessionId()
    if (original === undefined || original === sessionId) {
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
  }, [openChat, clearMainNow])

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
      // With the main column cleared there is nothing to wait for.
      if (mainClearedRef.current) {
        openChat(target)
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
    const drawerSession = chatRef.current?.sessionId
    chatRef.current = null
    chatWantedRef.current = undefined
    releaseRetained()
    const swap = swapRef.current
    swapRef.current = null
    swapPendingRef.current = undefined
    // Closing the map lands on whatever the drawer was showing; with no
    // drawer Session the pre-map Session is restored (the swap below, or the
    // main column the map cleared when it opened).
    if (drawerSession !== undefined) {
      window.setTimeout(() => { openSessionInMain(drawerSession) }, 0)
    } else if (swap !== null) {
      window.setTimeout(() => { openSessionInMain(swap.original) }, 0)
    } else if (clearedSessionRef.current !== undefined) {
      const restore = clearedSessionRef.current
      window.setTimeout(() => { openSessionInMain(restore) }, 0)
    }
    clearedSessionRef.current = undefined
    mainClearedRef.current = false
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
            <div className={styles['chatDrawerNoticeActions']}>
              <button
                type="button"
                className={styles['chatDrawerNoticeButton']}
                onClick={() => { setNotice(null); mapUi.setOpen(false) }}
              >
                {t('map.showMain')}
              </button>
              <button
                type="button"
                className={styles['chatDrawerNoticeButton']}
                onClick={() => { retryParking(notice.sessionId) }}
                disabled={retrying}
              >
                {retrying ? t('map.retryParkingBusy') : t('map.retryParking')}
              </button>
            </div>
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
          <div className={styles['chatDrawerBody']} ref={drawerBodyRef}>
            <props.SessionProvider session={chat.reference}>
              {props.renderSlot('talk-map.chat', { sessionId: chat.sessionId })}
            </props.SessionProvider>
          </div>
        </aside>
      )
    : null

  return (
    <div className={styles['overlay']} lang={activeLocale()} role="dialog" aria-label={t('map.title')}>
      <div className={styles['header']} data-talk-map-header="">
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
