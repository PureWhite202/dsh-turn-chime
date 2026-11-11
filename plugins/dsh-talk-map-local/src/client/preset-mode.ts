/**
 * Agent-preset ("mode") plumbing for the map drawer.
 *
 * The main view owns the canonical controls: a picker beside the workspace on
 * the new-session screen, and a read-only label beside the session title. The
 * drawer receives neither — the host's picker returns null outside the main
 * view (its `AgentPresetSeat` is main-view-only), and the drawer renders the
 * conversation body without the host's session header. So the map offers the
 * same two affordances itself:
 *
 *   - `HeroModeChip` rides `conversation.hero.options` (the one extension
 *     point inside the hero row) and stands where the workspace picker does;
 *   - `SessionModeLabel` sits in the drawer's own title bar.
 *
 * Switching follows the host contract: only a blank Session — one whose first
 * turn has not run — may take a new preset. The host refuses later with
 * `agent-preset/locked`, because the composition decides the tool schemas and
 * prompt sections the model already saw. Everything else here is display-only.
 */
import { useEffect, useState } from 'react'
import type { AgentPresetEntry, SessionSummary } from './dsh.ts'
import { getServices } from './map-state.ts'
import { t } from './i18n.ts'

/** Localized name of a shipped preset id; custom presets keep their own label. */
export function presetLabel(id: string): string {
  const key = `preset.${id}`
  const label = t(key)
  return label === key ? id : label
}

/** The name shown for one roster row: a declared name wins over the id. */
export function presetName(preset: AgentPresetEntry | undefined): string {
  if (preset === undefined) return ''
  return preset.name !== undefined && preset.name !== '' ? preset.name : presetLabel(preset.id)
}

/** Roster rows a picker may offer: a broken composition cannot start a Session. */
export function selectablePresets(presets: readonly AgentPresetEntry[]): AgentPresetEntry[] {
  return presets.filter(preset => preset.broken === undefined)
}

/**
 * Whether a roster row is gated behind the coding view preference. Mirrors the
 * host: only the SHIPPED PTC and Minimal presets need it; a declaration that
 * names itself (a custom override) keeps its own behaviour.
 */
export function requiresCodingView(preset: AgentPresetEntry): boolean {
  if (preset.name !== undefined) return false
  return preset.id === 'ptc' || preset.id === 'minimal'
}

/**
 * The rows the drawer's picker offers: healthy presets, with the deployment's
 * coding-view gate applied exactly like the host's own picker. An unavailable
 * preference (older host / service not mounted) offers everything rather than
 * hiding modes the user may still want.
 */
export function offeredPresets(
  presets: readonly AgentPresetEntry[],
  codingView: boolean | undefined,
): AgentPresetEntry[] {
  return selectablePresets(presets).filter(preset => codingView !== false || !requiresCodingView(preset))
}

/** The settings-form face the coding-view preference lives behind. */
interface UiSettingsFormLike {
  getSnapshot?: () => { value?: { enabled?: boolean } }
}
interface ConfigFormsLike {
  get?: (namespace: string) => UiSettingsFormLike | undefined
}

let configFormsProvider: (() => unknown) | undefined
let uiSettingsForm: UiSettingsFormLike | null | undefined

/**
 * Wire the optional `configForms` service. The lookup is lazy because the
 * settings plugin may still be mounting when this plugin applies, and the
 * service is optional on older hosts.
 */
export function attachConfigForms(provider: (() => unknown) | undefined): void {
  configFormsProvider = provider
  uiSettingsForm = undefined
}

function settingsForm(): UiSettingsFormLike | undefined {
  if (uiSettingsForm !== undefined) return uiSettingsForm ?? undefined
  try {
    const forms = configFormsProvider?.() as ConfigFormsLike | undefined
    // The service may still be mounting: stay uncached so a later read
    // retries instead of concluding the deployment has no settings face.
    if (forms === undefined) return undefined
    const form = forms.get?.('ui-settings')
    uiSettingsForm = form ?? null
    return form
  } catch {
    uiSettingsForm = null
    return undefined
  }
}

/** The deployment's coding-view preference; undefined when it cannot be read. */
export function codingViewEnabled(): boolean | undefined {
  try {
    const value = settingsForm()?.getSnapshot?.()?.value
    return typeof value?.enabled === 'boolean' ? value.enabled : undefined
  } catch {
    return undefined
  }
}

/**
 * The preset a Session records. The log projection is authoritative; the
 * roster default stands in for a freshly created Session that has not
 * recorded anything yet, which is what the host's own picker shows too.
 */
export function currentPresetId(
  summary: SessionSummary | undefined,
  presets: readonly AgentPresetEntry[],
): string | undefined {
  const projected = summary?.projectionValues?.agentPreset
  if (typeof projected === 'string' && projected !== '') return projected
  const legacy = summary?.agentPreset
  if (typeof legacy === 'string' && legacy !== '') return legacy
  return presets.find(preset => preset.isDefault === true)?.id
}

/**
 * Why a Session cannot take a new mode right now, or undefined when it can.
 * Mirrors the host guard: a started (or currently running) Session keeps the
 * composition its history was produced under.
 */
export function modeLockReason(
  summary: SessionSummary | undefined,
): 'missing' | 'running' | 'started' | undefined {
  if (summary === undefined) return 'missing'
  if (summary.running === true) return 'running'
  if (summary.blank !== true) return 'started'
  return undefined
}

/** The message shown when the host refuses a switch; localizes the known code. */
export function modeSwitchFailure(
  error: { readonly code?: string; readonly message?: string; readonly details?: { readonly reason?: string } } | undefined,
): string {
  if (error?.code === 'agent-preset/locked') return t('mode.lockedError')
  const detail = error?.details?.reason
  if (typeof detail === 'string' && detail !== '') return detail
  if (error?.message !== undefined && error.message !== '') return error.message
  return t('mode.failedUnknown')
}

/**
 * The roster is page-wide static: read it once per page and share it between
 * the hero chip and the title label. An empty answer is retried by the next
 * mount (the Remote may still be settling during boot).
 */
let modesPromise: Promise<readonly AgentPresetEntry[]> | null = null

export function loadPresetModes(): Promise<readonly AgentPresetEntry[]> {
  if (modesPromise !== null) return modesPromise
  const read = (async (): Promise<readonly AgentPresetEntry[]> => {
    try {
      const remote = getServices()?.remote
      if (remote === undefined) return []
      const list = await remote.agentPresets.list()
      return list.ok ? list.value.presets : []
    } catch (error) {
      console.warn('[dsh-talk-map] preset roster unavailable:', error)
      return []
    }
  })()
  modesPromise = read
  void read.then((presets) => { if (presets.length === 0) modesPromise = null })
  return read
}

/** Reactive roster for a component; [] until the first read lands. */
export function usePresetModes(): readonly AgentPresetEntry[] {
  const [modes, setModes] = useState<readonly AgentPresetEntry[]>([])
  useEffect(() => {
    let live = true
    void loadPresetModes().then((presets) => {
      if (live) setModes(presets)
    })
    return () => { live = false }
  }, [])
  return modes
}
