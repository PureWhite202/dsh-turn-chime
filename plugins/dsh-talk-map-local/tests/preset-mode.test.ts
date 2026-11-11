import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachConfigForms,
  codingViewEnabled,
  currentPresetId,
  modeLockReason,
  modeSwitchFailure,
  offeredPresets,
  presetLabel,
  presetName,
  requiresCodingView,
  selectablePresets,
} from '../src/client/preset-mode.ts'
import type { AgentPresetEntry, SessionSummary } from '../src/client/dsh.ts'

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

function preset(id: string, patch: Partial<AgentPresetEntry> = {}): AgentPresetEntry {
  return { id, ...patch }
}

test('built-in preset ids map to the localized mode names', () => {
  assert.equal(presetLabel('standard'), 'Standard mode')
  assert.equal(presetLabel('cordis'), 'Creator mode')
})

test('an unknown or custom id falls back to the id itself', () => {
  assert.equal(presetLabel('my-team-mode'), 'my-team-mode')
})

test('a declared preset name wins over the localized label', () => {
  assert.equal(presetName(preset('standard', { name: 'Team standard' })), 'Team standard')
  assert.equal(presetName(preset('standard')), 'Standard mode')
  assert.equal(presetName(preset('custom', { name: '' })), 'custom')
  assert.equal(presetName(undefined), '')
})

test('broken compositions never reach the picker', () => {
  const rows = [
    preset('standard'),
    preset('ptc', { broken: 'missing dependency' }),
    preset('minimal'),
  ]
  assert.deepEqual(selectablePresets(rows).map(row => row.id), ['standard', 'minimal'])
})

test('only the shipped PTC and Minimal presets need the coding view', () => {
  assert.equal(requiresCodingView(preset('ptc')), true)
  assert.equal(requiresCodingView(preset('minimal')), true)
  assert.equal(requiresCodingView(preset('standard')), false)
  assert.equal(requiresCodingView(preset('cordis')), false)
})

test('a named override of PTC keeps its own behaviour', () => {
  assert.equal(requiresCodingView(preset('ptc', { name: 'Team PTC' })), false)
})

test('the coding-view gate hides PTC/Minimal only when explicitly off', () => {
  const rows = [preset('standard'), preset('ptc'), preset('minimal'), preset('cordis')]
  assert.deepEqual(offeredPresets(rows, false).map(row => row.id), ['standard', 'cordis'])
  assert.deepEqual(offeredPresets(rows, true).map(row => row.id), ['standard', 'ptc', 'minimal', 'cordis'])
  assert.deepEqual(offeredPresets(rows, undefined).map(row => row.id), ['standard', 'ptc', 'minimal', 'cordis'])
})

test('the coding-view gate still drops broken rows', () => {
  const rows = [preset('ptc'), preset('standard', { broken: 'boom' })]
  assert.deepEqual(offeredPresets(rows, true).map(row => row.id), ['ptc'])
})

test('the coding-view preference is read from the ui-settings form', () => {
  attachConfigForms(() => ({
    get: () => ({ getSnapshot: () => ({ value: { enabled: false } }) }),
  }))
  assert.equal(codingViewEnabled(), false)
  attachConfigForms(undefined)
  assert.equal(codingViewEnabled(), undefined)
})

test('the recorded projection is the current preset', () => {
  const rows = [preset('standard'), preset('cordis', { isDefault: true })]
  assert.equal(currentPresetId(summary({ projectionValues: { agentPreset: 'cordis' } }), rows), 'cordis')
})

test('a null or absent projection falls back to the roster default', () => {
  const rows = [preset('standard'), preset('cordis', { isDefault: true })]
  assert.equal(currentPresetId(summary({ projectionValues: { agentPreset: null } }), rows), 'cordis')
  assert.equal(currentPresetId(summary(), rows), 'cordis')
})

test('the legacy summary field still counts when the projection is absent', () => {
  const rows = [preset('standard'), preset('cordis', { isDefault: true })]
  assert.equal(currentPresetId(summary({ agentPreset: 'ptc' }), rows), 'ptc')
})

test('no roster default leaves the current preset unknown', () => {
  assert.equal(currentPresetId(summary(), []), undefined)
})

test('a missing session cannot take a mode', () => {
  assert.equal(modeLockReason(undefined), 'missing')
})

test('a running session cannot take a mode', () => {
  assert.equal(modeLockReason(summary({ running: true })), 'running')
})

test('a started session keeps its mode', () => {
  assert.equal(modeLockReason(summary({ blank: false })), 'started')
})

test('a blank idle session may switch', () => {
  assert.equal(modeLockReason(summary()), undefined)
})

test('the locked refusal is localized instead of echoing the host message', () => {
  const message = modeSwitchFailure({ code: 'agent-preset/locked', message: 'This session has already started' })
  assert.match(message, /already started/)
  assert.doesNotMatch(message, /This session has already started/)
})

test('a structured refusal reason is shown verbatim', () => {
  assert.equal(modeSwitchFailure({ message: 'nope', details: { reason: 'composition broke' } }), 'composition broke')
})

test('a plain host failure message is shown', () => {
  assert.equal(modeSwitchFailure({ message: 'gateway down' }), 'gateway down')
})

test('an empty failure gets the generic fallback', () => {
  assert.notEqual(modeSwitchFailure(undefined), '')
  assert.notEqual(modeSwitchFailure({ code: '', message: '' }), '')
})
