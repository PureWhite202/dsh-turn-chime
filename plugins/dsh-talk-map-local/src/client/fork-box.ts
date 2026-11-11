/**
 * The placeholder a fork drag leaves on the board before anything exists.
 *
 * Dropping a connection on empty canvas used to open a full draft card right
 * away; now it drops a plain marker and the setup lives in the right-hand
 * drawer. The marker owns no Session, so it cannot ride the card store — it is
 * runtime-only state here (a reload drops it, exactly like the temporary
 * new-conversation boxes), and the drawer's setup panel reads it back when the
 * user starts the fork.
 */
import { useSyncExternalStore } from 'react'

/** One fork marker waiting for its setup. */
export interface ForkBox {
  readonly id: string
  /** Card the line was dragged from. */
  readonly parentCardId: string
  readonly parentSessionId: string
  readonly parentTitle: string
  /** Workspace the parent lives in: the fork lands there unless changed. */
  readonly parentWorkspaceId?: string
  /** Handle the gesture started from ('t' | 'r' | 'b' | 'l'). */
  readonly fromHandle?: string
  readonly x: number
  readonly y: number
}

export interface ForkBoxState {
  readonly boxes: ReadonlyMap<string, ForkBox>
  /** Box whose setup panel is open in the drawer, if any. */
  readonly activeId: string | undefined
}

let state: ForkBoxState = { boxes: new Map(), activeId: undefined }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function publish(next: ForkBoxState): void {
  state = next
  emit()
}

/** A fresh marker id; node ids are prefixed so the canvas can tell them apart. */
export function newForkBoxId(): string {
  return `fork-${crypto.randomUUID()}`
}

export function addForkBox(box: ForkBox): void {
  const boxes = new Map(state.boxes)
  boxes.set(box.id, box)
  // Dropping a line opens the setup right away, so the new box is active.
  publish({ boxes, activeId: box.id })
}

export function removeForkBox(id: string): void {
  if (!state.boxes.has(id)) return
  const boxes = new Map(state.boxes)
  boxes.delete(id)
  publish({ boxes, activeId: state.activeId === id ? undefined : state.activeId })
}

export function moveForkBox(id: string, x: number, y: number): void {
  const box = state.boxes.get(id)
  if (box === undefined || (box.x === x && box.y === y)) return
  const boxes = new Map(state.boxes)
  boxes.set(id, { ...box, x, y })
  publish({ boxes, activeId: state.activeId })
}

/** Mark one box as the one the drawer is setting up (undefined clears it). */
export function setActiveForkBox(id: string | undefined): void {
  if (state.activeId === id) return
  if (id !== undefined && !state.boxes.has(id)) return
  publish({ boxes: state.boxes, activeId: id })
}

export function getForkBox(id: string): ForkBox | undefined {
  return state.boxes.get(id)
}

export function getForkBoxState(): ForkBoxState {
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function subscribeForkBoxes(listener: () => void): () => void {
  return subscribe(listener)
}

export function useForkBoxState(): ForkBoxState {
  return useSyncExternalStore(subscribe, getForkBoxState)
}
