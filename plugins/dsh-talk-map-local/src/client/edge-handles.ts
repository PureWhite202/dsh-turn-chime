/**
 * Which handle a stored relationship leaves and enters.
 *
 * Two producers write edges:
 *   - the draw gesture, which knows the handle the user actually grabbed
 *     (connection start side) and keeps it;
 *   - programmatic edges (fork boxes, placements), which have no gesture and
 *     fall back to the cards' relative placement.
 *
 * The fallback used to be the ONLY rule, because fork edges stored no handle
 * at all and the renderer defaulted to right→left — so a line dragged from a
 * card's bottom point reappeared from its right point. Keeping the start
 * handle is the fix; this module is the shared, testable rule.
 */
import type { Card } from '../shared/model.ts'

export interface EdgeHandles {
  readonly fromHandle: string
  readonly toHandle: string
}

/** Anchor sides from the cards' relative placement. */
export function sideHandles(
  from: Pick<Card, 'x' | 'y'>,
  to: Pick<Card, 'x' | 'y'>,
): EdgeHandles {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromHandle: 'r', toHandle: 'l' } : { fromHandle: 'l', toHandle: 'r' }
  }
  return dy >= 0 ? { fromHandle: 'b', toHandle: 't' } : { fromHandle: 't', toHandle: 'b' }
}

/** The handle ids a board card renders: top, right, bottom, left. */
export function isBoardHandle(id: string | null | undefined): id is string {
  return id === 't' || id === 'r' || id === 'b' || id === 'l'
}

/** The handle a gesture started from when it is one we render, else undefined. */
export function drawnHandle(id: string | null | undefined): string | undefined {
  return isBoardHandle(id) ? id : undefined
}
