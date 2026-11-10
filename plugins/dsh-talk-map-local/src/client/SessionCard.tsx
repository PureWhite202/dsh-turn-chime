/**
 * The card node: one session on the board. Front face is the ADHD resume
 * surface — title, the digest's "next step" once M2 fills it, relative time,
 * running state. A card whose session no longer exists renders as a ghost
 * (grey, removable) — the host never auto-deletes placements.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { interactionMenu } from './interactions.ts'
import { canvas } from './canvas-store.ts'
import { colorOf } from './colors.ts'
import { t } from './i18n.ts'
import { toggleSessionPin, useArchivedSessionIds, usePinnedSessionIds } from './map-state.ts'
import styles from './talk-map.module.css'

export interface SessionCardData extends Record<string, unknown> {
  cardId: string
  sessionId: string
  title: string
  running: boolean
  ghost: boolean
  updatedAt?: number
  colorTag?: string
  /** Session is blocked on the user (approval / question). */
  waiting?: boolean
  /** Finished while unwatched and not yet opened. */
  done?: boolean
  /** Set when this card sits inside another workspace's frame: the real
   * workspace it belongs to (membership never changes — only the position). */
  foreignLabel?: string
  /** The card edge is touching/crossing that frame's dashed border. */
  foreignTouch?: boolean
  /** Precomputed relative-time label: memo() only re-renders the card when
   *  the label text actually changes (not every minute bucket). */
  timeLabel?: string
}

export type SessionCardNodeType = Node<SessionCardData, 'sessionCard'>

export function relativeTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return ''
  const delta = Date.now() - timestamp
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return t('time.now')
  if (minutes < 60) return `${minutes}${t('time.m')}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}${t('time.h')}`
  const days = Math.round(hours / 24)
  return `${days}${t('time.d')}`
}

/** Pushpin glyph shared by the card's pin toggle (filled while pinned). */
function PinIcon(props: { readonly filled: boolean }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={props.filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={props.filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
  )
}

function SessionCard(props: NodeProps<SessionCardNodeType>): React.JSX.Element {
  const { data, selected } = props
  const pinned = usePinnedSessionIds().has(data.sessionId)
  const archived = useArchivedSessionIds().has(data.sessionId)
  const classNames = [styles['card']]
  if (data.ghost) classNames.push(styles['cardGhost'])
  if (selected === true) classNames.push(styles['cardSelected'])
  if (data.foreignLabel !== undefined) classNames.push(styles['cardForeign'])
  if (data.foreignTouch === true) classNames.push(styles['cardForeignTouch'])

  const color = colorOf(data.colorTag)

  return (
    <div
      className={classNames.filter(Boolean).join(' ')}
      style={color !== undefined
        ? { borderColor: color.border, backgroundImage: `linear-gradient(${color.fill}, ${color.fill})` }
        : {}}
    >
      {/* Four connection points, one per side. All type "source" — the
        * canvas runs ConnectionMode.Loose, so each also accepts incoming
        * edges. Hidden until the card is hovered or a drag is in flight
        * (CSS); legacy edges without stored handles anchor r→l. */}
      <Handle id="t" type="source" position={Position.Top} className={styles['cardHandle'] ?? ''} />
      <Handle id="l" type="source" position={Position.Left} className={styles['cardHandle'] ?? ''} />
      <div className={styles['cardTop']}>
        {data.done === true && data.ghost !== true
          ? <span className={styles['cardDoneDot']} title={t('card.done')} aria-label={t('card.done')} />
          : null}
        <span className={styles['cardTitle']}>{data.ghost ? t('card.ghostTitle') : data.title}</span>
        {data.ghost !== true && !archived
          ? (
              <button
                type="button"
                // `nodrag` keeps a click from starting a card drag; archived
                // Sessions are skipped because the host refuses to pin them.
                className={pinned
                  ? `nodrag ${styles['cardPin'] ?? ''} ${styles['cardPinActive'] ?? ''}`
                  : `nodrag ${styles['cardPin'] ?? ''}`}
                title={pinned ? t('card.unpin') : t('card.pin')}
                aria-label={pinned ? t('card.unpin') : t('card.pin')}
                aria-pressed={pinned}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleSessionPin(data.sessionId)
                }}
                onPointerDown={(event) => { event.stopPropagation() }}
              >
                <PinIcon filled={pinned} />
              </button>
            )
          : null}
      </div>
      {data.ghost
        ? (
            <button
              type="button"
              className={`${styles['cardRemove']} nodrag`}
              onClick={() => { canvas.removeCard(data.cardId) }}
            >
              {t('card.remove')}
            </button>
          )
        : null}
      <div className={styles['cardFooter']}>
        <span className={styles['cardFooterLeft']}>
          {data.foreignLabel !== undefined
            ? (
                <span
                  className={styles['cardForeignChip']}
                  title={t('card.foreignHint', { name: data.foreignLabel })}
                >
                  {t('card.foreign')} · {data.foreignLabel}
                </span>
              )
            : null}
          <span className={styles['cardTime']}>{data.timeLabel ?? ''}</span>
        </span>
        {data.waiting === true
          ? (
              <button
                type="button"
                // `nodrag`: clicking the button must not start a card drag.
                className={`nodrag ${styles['cardWaitingButton'] ?? ''}`}
                title={t('card.waitingHint')}
                onClick={(event) => {
                  event.stopPropagation()
                  const wrapper = event.currentTarget.closest('[data-talk-map-canvas]')
                  if (!(wrapper instanceof HTMLElement)) return
                  const bounds = wrapper.getBoundingClientRect()
                  const rect = event.currentTarget.getBoundingClientRect()
                  interactionMenu.open(data.sessionId, {
                    left: rect.left - bounds.left,
                    top: rect.top - bounds.top,
                    bottom: rect.bottom - bounds.top,
                  })
                }}
              >
                {t('card.waiting')}
              </button>
            )
          : data.running
            ? <span className={styles['cardBadgeRunning']}><span className={styles['runningDot']} />{t('card.running')}</span>
            : null}
      </div>
      <Handle id="r" type="source" position={Position.Right} className={styles['cardHandle'] ?? ''} />
      <Handle id="b" type="source" position={Position.Bottom} className={styles['cardHandle'] ?? ''} />
    </div>
  )
}

/**
 * React Flow re-renders a node when its node object changes. CanvasInner
 * reuses unchanged node objects, so memo() lets untouched cards skip the
 * render entirely during drags, status ticks and digest updates.
 */
export const SessionCardNode = memo(SessionCard)
