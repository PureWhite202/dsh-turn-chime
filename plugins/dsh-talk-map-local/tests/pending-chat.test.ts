import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionSummary } from '../src/client/dsh.ts'
import {
  clearPendingChat,
  isPendingChat,
  markPendingChat,
  pendingAbandonAction,
  subscribePendingChats,
} from '../src/client/pending-chat.ts'

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    displayTitle: 'Session 1',
    running: false,
    blank: true,
    updatedAt: 0,
    ...patch,
  }
}

test('a marked conversation is pending until cleared', () => {
  assert.equal(isPendingChat('p-1'), false)
  markPendingChat('p-1')
  assert.equal(isPendingChat('p-1'), true)
  clearPendingChat('p-1')
  assert.equal(isPendingChat('p-1'), false)
})

test('marking twice notifies once', () => {
  let notified = 0
  const stop = subscribePendingChats(() => { notified += 1 })
  markPendingChat('p-2')
  markPendingChat('p-2')
  assert.equal(notified, 1)
  clearPendingChat('p-2')
  assert.equal(notified, 2)
  stop()
})

test('clearing an unknown id notifies nobody', () => {
  let notified = 0
  const stop = subscribePendingChats(() => { notified += 1 })
  clearPendingChat('p-never')
  assert.equal(notified, 0)
  stop()
})

test('walking away from a blank conversation archives it', () => {
  assert.equal(pendingAbandonAction(summary({ blank: true })), 'archive')
})

test('a conversation that already started is never archived', () => {
  assert.equal(pendingAbandonAction(summary({ blank: false })), 'keep')
})

test('a session missing from the catalog is left alone', () => {
  assert.equal(pendingAbandonAction(undefined), 'keep')
})

test('a running session keeps its card', () => {
  assert.equal(pendingAbandonAction(summary({ blank: false, running: true })), 'keep')
})
