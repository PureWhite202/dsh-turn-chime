/**
 * The card node: one session on the board. Front face is the ADHD resume
 * surface — title, the digest's "next step" once M2 fills it, relative time,
 * running state. A card whose session no longer exists renders as a ghost
 * (grey, removable) — the host never auto-deletes placements.
 */
import { memo, useState } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { talkMapApi } from './api.ts'
import { interactionMenu } from './interactions.ts'
import { canvas } from './canvas-store.ts'
import { colorOf } from './colors.ts'
import { t } from './i18n.ts'
import styles from './talk-map.module.css'

export interface SessionCardData extends Record<string, unknown> {
  cardId: string
  sessionId: string
  title: string
  running: boolean
  ghost: boolean
  updatedAt?: number
  nextStep?: string
  stale?: boolean
  colorTag?: string
  /** Digest summary, shown as the card body (2-line clamp). */
  summary?: string
  /** Session is blocked on the user (approval / question). */
  waiting?: boolean
  /** Finished while unwatched and not yet opened. */
  done?: boolean
  /** Set when this card sits inside another workspace's frame: the real
   * workspace it belongs to (membership never changes — only the position). */
  foreignLabel?: string
  /** The card edge is touching/crossing that frame's dashed border. */
  foreignTouch?: boolean
  /** Host-marked archived Session: the host rejects new turns for it. */
  archived?: boolean
  /** Minute bucket: a cheap re-render trigger so the relative time label
   *  stays fresh even when memo() skips an otherwise unchanged card. */
  nowMinute?: number
}

export type SessionCardNodeType = Node<SessionCardData, 'sessionCard'>

function relativeTime(timestamp: number | undefined): string {
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

function SessionCard(props: NodeProps<SessionCardNodeType>): React.JSX.Element {
  const { data, selected } = props
  const [refreshing, setRefreshing] = useState(false)
  const classNames = [styles['card']]
  if (data.ghost) classNames.push(styles['cardGhost'])
  if (selected === true) classNames.push(styles['cardSelected'])
  if (data.foreignLabel !== undefined) classNames.push(styles['cardForeign'])
  if (data.foreignTouch === true) classNames.push(styles['cardForeignTouch'])

  const refreshDigest = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await talkMapApi.refreshDigest(data.sessionId)
    } catch (error) {
      console.error('[dsh-talk-map] digest refresh failed:', error)
    } finally {
      setRefreshing(false)
    }
  }

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
        {data.ghost
          ? null
          : (
              <button
                type="button"
                className={`${styles['cardRefresh']} nodrag${refreshing ? ` ${styles['cardRefreshBusy']}` : ''}`}
                title={t('card.refresh')}
                aria-label={t('card.refresh')}
                onClick={(event) => {
                  event.stopPropagation()
                  void refreshDigest()
                }}
              >
                ⟳
              </button>
            )}
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
        : (
            <>
              {data.summary !== undefined && data.summary !== ''
                ? <div className={styles['cardSummary']}>{data.summary}</div>
                : null}
              {data.nextStep !== undefined && data.nextStep !== ''
                ? (
                    <div className={styles['cardNext']}>
                      <span className={styles['cardNextLabel']}>{t('card.next')}</span>
                      <span className={styles['cardNextText']}>{data.nextStep}</span>
                      {data.stale === true ? <span className={styles['cardStale']} title={t('card.stale')}>⟳</span> : null}
                    </div>
                  )
                : null}
            </>
          )}
      <div className={styles['cardFooter']}>
        <span className={styles['cardFooterLeft']}>
          {data.archived === true
            ? (
                <span className={styles['cardArchivedChip']} title={t('card.archivedHint')}>
                  {t('card.archived')}
                </span>
              )
            : null}
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
          <span className={styles['cardTime']}>{relativeTime(data.updatedAt)}</span>
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
