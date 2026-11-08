/**
 * Pending user-facing interactions surfaced on the board.
 *
 * The host publishes every approval / question / plan review through
 * `ctx.uiSession.sessionStatus`, keyed by Session. The map mirrors that store
 * into a tiny external store so cards can show a "needs you" button without
 * rendering the whole overlay for every status tick. The interaction objects
 * are the live ones: calling their `answer()` settles the very Host request
 * the Conversation's composer card would settle.
 */
import type { PendingInteractionLike, SessionStatusLike } from './dsh.ts'

interface InteractionSource {
  getSnapshot(): ReadonlyMap<string, SessionStatusLike>
  subscribe(listener: () => void): () => void
}

let source: InteractionSource | undefined
let detachSource: (() => void) | undefined
let snapshot: ReadonlyMap<string, PendingInteractionLike> = new Map()
const listeners = new Set<() => void>()
/** Session ids the host reports as finished-but-unread (the sidebar's dot). */
let completedSnapshot: ReadonlySet<string> = new Set()
const completedListeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function emitCompleted(): void {
  for (const listener of completedListeners) listener()
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

function recompute(): void {
  // Completion-unread rides the same status source as the pending menu: it is
  // what the sidebar's green dot shows, and it must match on the cards too.
  const nextCompleted = new Set<string>()
  if (source !== undefined) {
    for (const [sessionId, status] of source.getSnapshot()) {
      if (status?.completionUnread === true) nextCompleted.add(sessionId)
    }
  }
  if (!sameSet(nextCompleted, completedSnapshot)) {
    completedSnapshot = nextCompleted
    emitCompleted()
  }
  if (source === undefined) {
    if (snapshot.size === 0) return
    snapshot = new Map()
    emit()
    return
  }
  const next = new Map<string, PendingInteractionLike>()
  for (const [sessionId, status] of source.getSnapshot()) {
    const interaction = status?.pendingInteraction
    if (interaction !== undefined && interaction !== null) next.set(sessionId, interaction)
  }
  // Identical maps (same keys, same live objects) must not wake subscribers:
  // the status store ticks on running/completion changes too.
  if (next.size === snapshot.size) {
    let same = true
    for (const [sessionId, interaction] of next) {
      if (snapshot.get(sessionId) !== interaction) {
        same = false
        break
      }
    }
    if (same) return
  }
  snapshot = next
  emit()
}

export const interactions = {
  getSnapshot(): ReadonlyMap<string, PendingInteractionLike> {
    return snapshot
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** Point the store at a host status source (undefined detaches). */
  attach(next: InteractionSource | undefined): void {
    detachSource?.()
    detachSource = undefined
    source = next
    if (next !== undefined) detachSource = next.subscribe(recompute)
    recompute()
  },
}

export function interactionOf(sessionId: string): PendingInteractionLike | undefined {
  return snapshot.get(sessionId)
}

/** Finished-but-unread Sessions, from the same host status the sidebar uses. */
export const completions = {
  getSnapshot(): ReadonlySet<string> {
    return completedSnapshot
  },
  subscribe(listener: () => void): () => void {
    completedListeners.add(listener)
    return () => { completedListeners.delete(listener) }
  },
}

/** Anchor of the button that opened the menu, in canvas-wrapper pixels. */
export interface InteractionAnchor {
  readonly left: number
  readonly top: number
  readonly bottom: number
}

export interface InteractionMenuState extends InteractionAnchor {
  readonly sessionId: string
}

let menuState: InteractionMenuState | null = null
const menuListeners = new Set<() => void>()

function emitMenu(): void {
  for (const listener of menuListeners) listener()
}

export const interactionMenu = {
  get(): InteractionMenuState | null {
    return menuState
  },
  subscribe(listener: () => void): () => void {
    menuListeners.add(listener)
    return () => { menuListeners.delete(listener) }
  },
  open(sessionId: string, anchor: InteractionAnchor): void {
    menuState = { sessionId, ...anchor }
    emitMenu()
  },
  close(): void {
    if (menuState === null) return
    menuState = null
    emitMenu()
  },
}
