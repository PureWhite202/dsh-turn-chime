import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addForkBox,
  getForkBox,
  getForkBoxState,
  moveForkBox,
  newForkBoxId,
  removeForkBox,
  setActiveForkBox,
  subscribeForkBoxes,
} from '../src/client/fork-box.ts'
import type { ForkBox } from '../src/client/fork-box.ts'

function box(id: string, patch: Partial<ForkBox> = {}): ForkBox {
  return {
    id,
    parentCardId: 'card-1',
    parentSessionId: 's-1',
    parentTitle: 'Parent',
    x: 0,
    y: 0,
    ...patch,
  }
}

test('a dropped marker becomes the active one', () => {
  addForkBox(box('fork-a'))
  assert.equal(getForkBoxState().activeId, 'fork-a')
  assert.equal(getForkBox('fork-a')?.parentTitle, 'Parent')
  addForkBox(box('fork-b'))
  assert.equal(getForkBoxState().activeId, 'fork-b')
  assert.equal(getForkBoxState().boxes.size, 2)
  removeForkBox('fork-b')
  removeForkBox('fork-a')
})

test('removing the active marker clears the active id', () => {
  addForkBox(box('fork-c'))
  removeForkBox('fork-c')
  assert.equal(getForkBoxState().activeId, undefined)
  assert.equal(getForkBox('fork-c'), undefined)
})

test('removing an inactive marker leaves the active one alone', () => {
  addForkBox(box('fork-d'))
  addForkBox(box('fork-e'))
  removeForkBox('fork-d')
  assert.equal(getForkBoxState().activeId, 'fork-e')
  removeForkBox('fork-e')
})

test('dragging a marker keeps it active and records the new spot', () => {
  addForkBox(box('fork-f'))
  moveForkBox('fork-f', 320, 96)
  assert.deepEqual(
    { x: getForkBox('fork-f')?.x, y: getForkBox('fork-f')?.y },
    { x: 320, y: 96 },
  )
  assert.equal(getForkBoxState().activeId, 'fork-f')
  removeForkBox('fork-f')
})

test('activating an unknown marker is ignored', () => {
  setActiveForkBox('fork-missing')
  assert.equal(getForkBoxState().activeId, undefined)
})

test('the active marker can be cleared without deleting it', () => {
  addForkBox(box('fork-g'))
  setActiveForkBox(undefined)
  assert.equal(getForkBoxState().activeId, undefined)
  assert.equal(getForkBox('fork-g')?.id, 'fork-g')
  removeForkBox('fork-g')
})

test('subscribers hear about every mutation', () => {
  let seen = 0
  const stop = subscribeForkBoxes(() => { seen += 1 })
  addForkBox(box('fork-h'))
  moveForkBox('fork-h', 16, 32)
  setActiveForkBox(undefined)
  removeForkBox('fork-h')
  assert.equal(seen, 4)
  stop()
})

test('new marker ids are unique and board-prefixed', () => {
  const first = newForkBoxId()
  const second = newForkBoxId()
  assert.notEqual(first, second)
  assert.match(first, /^fork-/)
})
