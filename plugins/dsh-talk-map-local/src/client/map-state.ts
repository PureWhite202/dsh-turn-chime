/**
 * Map UI state shared between the sidebar toggle button and the overlay —
 * two components registered into unrelated slots, so they meet through this
 * module-level external store (useSyncExternalStore on the React side).
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { ConnectionService, FileDragService, FileUploadService, RemoteService, SessionsService, UiWorkspaceService, WorkspacesService } from './dsh.ts'

export interface MapUiState {
  readonly open: boolean
}

type Listener = () => void

const listeners = new Set<Listener>()
let state: MapUiState = { open: false }

/** The map is a long-lived surface: remember whether it was open so a page
 * reload or desktop-app restart brings it back instead of dropping the user
 * into the main view. Purely a local preference — the map DATA lives on the
 * host either way. */
const OPEN_KEY = 'dsh-talk-map.open'

export function persistedMapOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

const DRAWER_KEY = 'dsh-talk-map.drawer'

/** Session left open in the map's right drawer (restored with the map). */
export function persistedDrawer(): string | undefined {
  try {
    const value = window.localStorage.getItem(DRAWER_KEY)
    return value === null || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

export function persistDrawer(sessionId: string | undefined): void {
  try {
    if (sessionId === undefined) window.localStorage.removeItem(DRAWER_KEY)
    else window.localStorage.setItem(DRAWER_KEY, sessionId)
  } catch {
    /* private mode / storage disabled — the drawer still works for this run */
  }
}

function persistMapOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    /* private mode / storage disabled — the map still works for this run */
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Escape routing: inner surfaces (draft card, spawn preview) claim Esc so
 * the overlay's own Esc-to-close stands down while one of them is open.
 */
const escGuards = new Set<string>()

export const mapUi = {
  get(): MapUiState {
    return state
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  setOpen(open: boolean): void {
    if (state.open === open) return
    state = { ...state, open }
    persistMapOpen(open)
    emit()
  },
  toggle(): void {
    mapUi.setOpen(!state.open)
  },
  claimEscape(id: string): () => void {
    escGuards.add(id)
    return () => { escGuards.delete(id) }
  },
  escapeClaimed(): boolean {
    return escGuards.size > 0
  },
}

/**
 * One transient message raised outside React — the file-open fallback reports
 * through the map's own toast instead of the host's modal.
 */
export interface MapNotice {
  readonly message: string
  readonly seq: number
}

const noticeListeners = new Set<Listener>()
let notice: MapNotice | null = null
let noticeSeq = 0

/** Publish a message for the map toast; the canvas clears it after showing. */
export function showMapNotice(message: string): void {
  noticeSeq += 1
  notice = { message, seq: noticeSeq }
  for (const listener of noticeListeners) listener()
}

/** Drop one shown notice; a newer notice keeps the floor. */
export function clearMapNotice(seq: number): void {
  if (notice === null || notice.seq !== seq) return
  notice = null
}

export function subscribeMapNotice(listener: Listener): () => void {
  noticeListeners.add(listener)
  return () => { noticeListeners.delete(listener) }
}

export function getMapNotice(): MapNotice | null {
  return notice
}

/**
 * Service handles captured at apply() time so components can navigate
 * (open/create sessions) without threading ctx through props.
 */
export interface MapServices {
  sessions: SessionsService
  workspaces: WorkspacesService
  connection: ConnectionService
  /** Official browser upload service for draft attachments. */
  fileUpload: FileUploadService
  /** Official application-internal file drag reader (drawer images → draft). */
  fileDrag: FileDragService
  /** Generated Remote namespaces; absent on hosts without the gateway. */
  remote?: RemoteService
  /** Host session selection; absent on older hosts. */
  uiWorkspace?: UiWorkspaceService
}

let services: MapServices | undefined

export function attachServices(next: MapServices | undefined): void {
  services = next
}

export function getServices(): MapServices | undefined {
  return services
}

const EMPTY_ARCHIVED: readonly string[] = []

/**
 * Archived Session ids from the host's workspace model (reactive). Archived
 * Sessions still render on the map, but the host rejects new turns for them.
 */
export function useArchivedSessionIds(): ReadonlySet<string> {
  // `subscribe`/`getSnapshot` are model methods: call them through the model
  // so `this` stays bound (a bare function reference crashes on this.listeners).
  const subscribe = useMemo(
    () => (listener: () => void): (() => void) => {
      const list = getServices()?.workspaces.list
      return list?.subscribe?.(listener) ?? (() => undefined)
    },
    [],
  )
  const ids = useSyncExternalStore(
    subscribe,
    () => getServices()?.workspaces.list?.getSnapshot().archivedSessionIds ?? EMPTY_ARCHIVED,
  )
  return useMemo(() => new Set(ids), [ids])
}

const EMPTY_PINNED: readonly string[] = []

/**
 * Pinned Session ids from the host's workspace model (reactive). The host's
 * sidebar fronts pinned Sessions; a card's pin toggle writes through the same
 * model, so both surfaces always agree.
 */
export function usePinnedSessionIds(): ReadonlySet<string> {
  const subscribe = useMemo(
    () => (listener: () => void): (() => void) => {
      const list = getServices()?.workspaces.list
      return list?.subscribe?.(listener) ?? (() => undefined)
    },
    [],
  )
  const ids = useSyncExternalStore(
    subscribe,
    () => getServices()?.workspaces.list?.getSnapshot().pinnedSessionIds ?? EMPTY_PINNED,
  )
  return useMemo(() => new Set(ids), [ids])
}

/**
 * Flip one Session's pin through the host's own sidebar action. Failures are
 * host-reported (the list model stays authoritative, so the UI already holds
 * the truth); the error is logged rather than surfaced as plugin chrome.
 */
export function toggleSessionPin(sessionId: string): void {
  const ui = getServices()?.uiWorkspace
  const pinned = getServices()?.workspaces.list?.getSnapshot().pinnedSessionIds?.includes(sessionId) === true
  const call = pinned ? ui?.unpinSession : ui?.pinSession
  if (call === undefined) return
  try {
    Promise.resolve(call.call(ui, sessionId)).catch((error: unknown) => {
      console.warn('[dsh-talk-map] pin toggle failed:', error)
    })
  } catch (error) {
    console.warn('[dsh-talk-map] pin toggle failed:', error)
  }
}

/**
 * The Client Remote surface mixes plain values with result envelopes: the
 * generated methods unwrap a success to its value, while some callbacks still
 * hand back `{ ok, value }`. Normalize both; a `{ ok: false }` envelope turns
 * into a thrown error (failed calls already throw).
 */
export function unwrapRemote<T>(result: unknown, what: string): T {
  if (result !== null && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
    const envelope = result as {
      ok: boolean
      value?: T
      error?: { code?: string; message?: string }
    }
    if (envelope.ok) return envelope.value as T
    throw new Error(`${what}: ${envelope.error?.code ?? ''} ${envelope.error?.message ?? ''}`.trim())
  }
  return result as T
}

/** A create/fork reply: either the id string or a `{ sessionId }` value. */
export function sessionIdOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    const sessionId = (value as { sessionId?: unknown }).sessionId
    if (typeof sessionId === 'string') return sessionId
  }
  return undefined
}
export function openSessionInMain(sessionId: string): void {
  if (services === undefined) return
  if (services.uiWorkspace !== undefined) {
    services.uiWorkspace.openSession(sessionId)
    return
  }
  const legacy = services.sessions as { open?: (id: string) => void }
  legacy.open?.(sessionId)
}
