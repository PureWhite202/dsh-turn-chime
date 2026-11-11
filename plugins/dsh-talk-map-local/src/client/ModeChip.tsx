/**
 * The drawer's two mode surfaces, mirroring the main view's split:
 *
 *   - `HeroModeChip` — the picker that sits beside the workspace picker on a
 *     brand-new conversation. It rides the host's `conversation.hero.options`
 *     list slot, the only place a plugin can add a control inside the hero
 *     row (`conversation.hero.agentPreset` is a single-seat slot the host's
 *     own picker owns). It renders only for the conversation the map's
 *     drawer is showing; main-view occurrences keep the host's picker.
 *
 *   - `SessionModeLabel` — the read-only badge beside the drawer title once
 *     the conversation has started. The host renders the same label in its
 *     own session header, which the drawer never mounts.
 *
 * Picking a mode calls `agentPresets.select` — the host accepts it only while
 * the Session is blank and refuses started Sessions with `agent-preset/locked`.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentPresetEntry, SessionListState, SnapshotSelectorHook } from './dsh.ts'
import { getServices, mapUi, useDrawerSessionId } from './map-state.ts'
import { activeLocale, subscribeLocale, t } from './i18n.ts'
import {
  codingViewEnabled,
  currentPresetId,
  modeLockReason,
  modeSwitchFailure,
  offeredPresets,
  presetName,
  usePresetModes,
} from './preset-mode.ts'
import styles from './talk-map.module.css'

/** Preset glyph (three sliders), matching the host's agent-preset icon. */
function ModeIcon(props: { readonly size?: number }): React.JSX.Element {
  const size = props.size ?? 14
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M4 12h8M4 17h5" />
      <circle cx="17" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="13" cy="17" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

/** Props the slot standard kit supplies to a session-scoped entry. */
export interface HeroModeChipProps {
  sessionId?: string
  useSessions: SnapshotSelectorHook<SessionListState>
}

/**
 * The picker on the drawer's new-conversation hero. It appears only while
 * the Session is still blank — the exact window in which the host accepts a
 * preset switch.
 */
export function HeroModeChip(props: HeroModeChipProps): React.JSX.Element | null {
  const sessionId = props.sessionId
  const summary = props.useSessions(state => (sessionId === undefined ? undefined : state.byId[sessionId]))
  const drawerSessionId = useDrawerSessionId()
  const mapOpen = useSyncExternalStore(mapUi.subscribe, () => mapUi.get().open)
  // The map's language switch re-renders the overlay; this entry lives inside
  // the host's conversation tree, so it subscribes to the same source.
  useSyncExternalStore(subscribeLocale, activeLocale)
  const roster = usePresetModes()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** The committed id shows immediately; the log projection catches up. */
  const [optimistic, setOptimistic] = useState<string | undefined>(undefined)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  const options = useMemo(
    () => offeredPresets(roster, codingViewEnabled()),
    [roster],
  )

  // Once the projection agrees, the optimistic value has served its purpose.
  const recorded = summary?.projectionValues?.agentPreset
  useEffect(() => {
    if (optimistic !== undefined && recorded === optimistic) setOptimistic(undefined)
  }, [recorded, optimistic])

  // Close on an outside press or Escape. The menu is a drawer surface, so
  // Escape must not bubble into the overlay's close-the-drawer handling.
  useEffect(() => {
    if (!open) return
    const release = mapUi.claimEscape('mode-menu')
    const onPointerDown = (event: PointerEvent): void => {
      const wrap = wrapRef.current
      if (wrap !== null && event.target instanceof Node && wrap.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      release()
    }
  }, [open])

  if (sessionId === undefined || summary === undefined) return null
  // Only the drawer's own conversation gets this picker, and only while the
  // map is on screen; the host owns the main-view hero, which renders its
  // own (identical) chip.
  if (!mapOpen || drawerSessionId !== sessionId) return null
  if (options.length === 0) return null
  // A started Session may not switch; its title-bar label replaces this.
  if (modeLockReason(summary) !== undefined) return null

  const currentId = optimistic ?? currentPresetId(summary, roster)
  // The label names the recorded preset even when the coding-view gate keeps
  // it out of the menu — the host's own labels behave the same way.
  const label = presetName(roster.find(preset => preset.id === currentId))
    || (currentId === undefined ? t('mode.choose') : currentId)

  const choose = async (id: string): Promise<void> => {
    if (busy) return
    if (id === currentId) {
      setOpen(false)
      return
    }
    const remote = getServices()?.remote
    if (remote === undefined) {
      setError(t('mode.failedUnknown'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await remote.agentPresets.select(sessionId, id)
      if (result.ok) {
        setOptimistic(result.value !== '' ? result.value : id)
        setOpen(false)
      } else {
        setError(modeSwitchFailure(result.error))
      }
    } catch (failure) {
      setError(failure instanceof Error && failure.message !== '' ? failure.message : t('mode.failedUnknown'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={styles['modeChipWrap']} ref={wrapRef}>
      <button
        type="button"
        className={styles['modeChip']}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('mode.title')}
        disabled={busy}
        onClick={() => {
          setError(undefined)
          setOpen(value => !value)
        }}
      >
        <span className={styles['modeChipIcon']}><ModeIcon /></span>
        <span className={styles['modeChipLabel']}>{label}</span>
        <span className={styles['modeChipChevron']}><ChevronIcon /></span>
      </button>
      {open
        ? (
            <div className={styles['modeMenu']} role="menu" aria-label={t('mode.title')}>
              <div className={styles['modeMenuTitle']}>{t('mode.title')}</div>
              {options.map((preset) => {
                const active = preset.id === currentId
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={active
                      ? `${styles['modeMenuItem']} ${styles['modeMenuItemActive']}`
                      : styles['modeMenuItem']}
                    disabled={busy}
                    onClick={() => { void choose(preset.id) }}
                  >
                    <span className={styles['modeMenuItemName']}>
                      {presetName(preset)}
                      {active ? <span className={styles['modeMenuCheck']}>✓</span> : null}
                    </span>
                    {preset.description !== undefined && preset.description !== ''
                      ? <span className={styles['modeMenuItemDesc']}>{preset.description}</span>
                      : null}
                  </button>
                )
              })}
              {busy ? <div className={styles['modeMenuHint']}>{t('mode.switching')}</div> : null}
              {error !== undefined ? <div className={styles['modeMenuError']}>{error}</div> : null}
            </div>
          )
        : null}
    </span>
  )
}

export interface SessionModeLabelProps {
  sessionId: string
  useSessions: SnapshotSelectorHook<SessionListState>
}

/**
 * Read-only mode badge for the drawer title bar: what the conversation runs
 * with, once it has started. Hidden while blank (the hero picker covers it).
 */
export function SessionModeLabel(props: SessionModeLabelProps): React.JSX.Element | null {
  const summary = props.useSessions(state => state.byId[props.sessionId])
  useSyncExternalStore(subscribeLocale, activeLocale)
  const roster = usePresetModes()
  if (summary === undefined || summary.blank !== false) return null
  const projected = summary.projectionValues?.agentPreset
  const id = typeof projected === 'string' && projected !== ''
    ? projected
    : summary.agentPreset
  if (id === undefined || id === '') return null
  const preset: AgentPresetEntry | undefined = roster.find(entry => entry.id === id)
  const label = presetName(preset) !== '' ? presetName(preset) : id
  return (
    <span
      className={styles['chatDrawerMode']}
      title={preset?.description ?? t('mode.lockedHint')}
      aria-label={`${t('mode.title')} · ${label}`}
    >
      <span className={styles['chatDrawerModeIcon']}><ModeIcon size={12} /></span>
      <span className={styles['chatDrawerModeText']}>{label}</span>
    </span>
  )
}
