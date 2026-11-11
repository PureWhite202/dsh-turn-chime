/**
 * "Select this card on the board" — the one update the drawer cannot apply
 * itself, because React Flow's selection state lives inside the canvas.
 *
 * The fork setup creates a card while the drawer holds the focus; after the
 * drawer switches to the new conversation the card should already read as the
 * selected card (the state a click would have left). The setup drops a request
 * here; the canvas consumes it once the card exists.
 */
import { useSyncExternalStore } from 'react'

export interface CardSelectionRequest {
  readonly cardId: string
  readonly seq: number
}

let request: CardSelectionRequest | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Ask the board to select one card (no-op when it already is). */
export function requestCardSelection(cardId: string): void {
  seq += 1
  request = { cardId, seq }
  emit()
}

/** The canvas confirms it applied the request; later requests keep the floor. */
export function consumeCardSelectionRequest(appliedSeq: number): void {
  if (request === null || request.seq !== appliedSeq) return
  request = null
  emit()
}

export function getCardSelectionRequest(): CardSelectionRequest | null {
  return request
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useCardSelectionRequest(): CardSelectionRequest | null {
  return useSyncExternalStore(subscribe, getCardSelectionRequest)
}
