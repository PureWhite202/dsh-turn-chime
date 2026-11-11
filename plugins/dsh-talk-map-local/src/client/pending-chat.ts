/**
 * The placeholder a fresh conversation leaves on the board.
 *
 * 右键「新对话」 (and an empty-canvas double-click) creates the Session and
 * its placement immediately, but a blank Session is deliberately hidden from
 * the board — an empty log is noise. That leaves the map looking empty right
 * after the click, so this store marks the new placement as TEMPORARY: the
 * canvas draws it as a placeholder box, and the overlay withdraws it when the
 * user walks away without sending anything.
 *
 * A temporary box owns a BLANK Session only. Once the first turn lands it is
 * an ordinary card: no archive, no marker. The marker is runtime-only on
 * purpose — a reload drops it (the blank card stays hidden exactly as before
 * instead of resurrecting a stale box) and can never archive a Session the
 * user actually started.
 */
import { useSyncExternalStore } from 'react'
import type { SessionSummary } from './dsh.ts'

const listeners = new Set<() => void>()
let pending: ReadonlySet<string> = new Set()

function emit(): void {
  for (const listener of listeners) listener()
}

/** The new conversation is on screen but has not taken its first turn yet. */
export function markPendingChat(sessionId: string): void {
  if (pending.has(sessionId)) return
  const next = new Set(pending)
  next.add(sessionId)
  pending = next
  emit()
}

/** The placeholder is gone (started, withdrawn, or unmounted). */
export function clearPendingChat(sessionId: string): void {
  if (!pending.has(sessionId)) return
  const next = new Set(pending)
  next.delete(sessionId)
  pending = next
  emit()
}

/** Whether this Session is currently drawn as a temporary box. */
export function isPendingChat(sessionId: string): boolean {
  return pending.has(sessionId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Observe marker changes (the canvas draws temporary boxes from this). */
export function subscribePendingChats(listener: () => void): () => void {
  return subscribe(listener)
}

function snapshot(): ReadonlySet<string> {
  return pending
}

/** Reactive view of the temporary boxes on the board. */
export function usePendingChatSessions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot)
}

/** What walking away from a temporary box must do to its Session. */
export type PendingAbandonAction = 'archive' | 'keep'

/**
 * A temporary box owns a blank Session. Leaving after the first turn must
 * never archive anything, and a Session already gone from the catalog is not
 * ours to touch either — only a confirmed blank one is withdrawn.
 */
export function pendingAbandonAction(summary: SessionSummary | undefined): PendingAbandonAction {
  if (summary === undefined) return 'keep'
  return summary.blank === true ? 'archive' : 'keep'
}
