import test from 'node:test'
import assert from 'node:assert/strict'
import {
  consumeCardSelectionRequest,
  getCardSelectionRequest,
  requestCardSelection,
} from '../src/client/selection-request.ts'

test('a selection request is consumed once by its sequence', () => {
  requestCardSelection('card-1')
  const request = getCardSelectionRequest()
  assert.notEqual(request, null)
  assert.equal(request?.cardId, 'card-1')
  consumeCardSelectionRequest(request?.seq ?? -1)
  assert.equal(getCardSelectionRequest(), null)
})

test('a stale sequence never clears a newer request', () => {
  requestCardSelection('card-2')
  const stale = getCardSelectionRequest()?.seq ?? -1
  requestCardSelection('card-3')
  consumeCardSelectionRequest(stale)
  assert.equal(getCardSelectionRequest()?.cardId, 'card-3')
})

test('the newest request wins', () => {
  requestCardSelection('card-4')
  requestCardSelection('card-5')
  const request = getCardSelectionRequest()
  assert.equal(request?.cardId, 'card-5')
  consumeCardSelectionRequest(request?.seq ?? -1)
  assert.equal(getCardSelectionRequest(), null)
})
