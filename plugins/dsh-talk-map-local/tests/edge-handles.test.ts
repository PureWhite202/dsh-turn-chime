import test from 'node:test'
import assert from 'node:assert/strict'
import { drawnHandle, isBoardHandle, sideHandles } from '../src/client/edge-handles.ts'

const at = (x: number, y: number): { x: number; y: number } => ({ x, y })

test('a card to the right anchors right → left', () => {
  assert.deepEqual(sideHandles(at(0, 0), at(300, 20)), { fromHandle: 'r', toHandle: 'l' })
})

test('a card to the left anchors left → right', () => {
  assert.deepEqual(sideHandles(at(300, 0), at(0, 20)), { fromHandle: 'l', toHandle: 'r' })
})

test('a card below anchors bottom → top', () => {
  assert.deepEqual(sideHandles(at(0, 0), at(20, 300)), { fromHandle: 'b', toHandle: 't' })
})

test('a card above anchors top → bottom', () => {
  assert.deepEqual(sideHandles(at(0, 300), at(20, 0)), { fromHandle: 't', toHandle: 'b' })
})

test('a diagonal distance ties toward the horizontal side', () => {
  assert.deepEqual(sideHandles(at(0, 0), at(120, 120)), { fromHandle: 'r', toHandle: 'l' })
})

test('only the four board handles are accepted from a gesture', () => {
  for (const id of ['t', 'r', 'b', 'l']) {
    assert.equal(isBoardHandle(id), true)
    assert.equal(drawnHandle(id), id)
  }
  for (const id of ['', 'x', 'right', 'R', null, undefined]) {
    assert.equal(isBoardHandle(id), false)
    assert.equal(drawnHandle(id), undefined)
  }
})
