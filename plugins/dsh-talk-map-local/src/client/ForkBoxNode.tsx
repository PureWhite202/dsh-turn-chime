/**
 * The fork marker on the board: a dashed box dropped by a connection drag.
 * Nothing exists behind it yet — no Session, no card — so it deliberately
 * offers none of the card affordances (context menu, pin, edge handles). A
 * click opens the setup panel in the drawer; the × removes the marker.
 */
import { memo } from 'react'
import type { NodeProps, Node } from '@xyflow/react'
import { t } from './i18n.ts'
import styles from './talk-map.module.css'

export interface ForkBoxData extends Record<string, unknown> {
  /** Title of the card the line was dragged from. */
  parentTitle: string
  /** The drawer's setup panel is showing this marker. */
  active: boolean
  onRemove: () => void
}

export type ForkBoxNodeType = Node<ForkBoxData, 'forkBox'>

function ForkBox(props: NodeProps<ForkBoxNodeType>): React.JSX.Element {
  const { data } = props
  return (
    <div
      className={data.active ? `${styles['forkBox']} ${styles['forkBoxActive']}` : styles['forkBox']}
      data-talk-map-fork-box=""
    >
      <button
        type="button"
        className={`nodrag ${styles['forkBoxRemove']}`}
        title={t('fork.remove')}
        aria-label={t('fork.remove')}
        onClick={(event) => {
          event.stopPropagation()
          data.onRemove()
        }}
      >
        ×
      </button>
      <div className={styles['forkBoxTitle']}>{t('fork.boxTitle')}</div>
      <div className={styles['forkBoxFrom']}>{t('fork.from', { name: data.parentTitle })}</div>
      <div className={styles['forkBoxHint']}>{t('fork.boxHint')}</div>
    </div>
  )
}

export const ForkBoxNode = memo(ForkBox)
