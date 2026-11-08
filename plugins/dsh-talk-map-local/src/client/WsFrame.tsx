/**
 * Workspace frame: a derived region drawn behind the cards of one map group.
 * Geometry follows its members — drag a card anywhere and the frame
 * stretches after it. The body center is pointer-transparent (pan and
 * double-click pass through); the dashed border strips and the label chip
 * are the frame's physical surfaces — click to select, drag to move the
 * whole group (the canvas translates every member card).
 */
import { memo } from 'react'
import type { NodeProps, Node } from '@xyflow/react'
import { colorOf } from './colors.ts'
import { t } from './i18n.ts'
import styles from './talk-map.module.css'

export interface WsFrameData extends Record<string, unknown> {
  workspaceId: string
  title: string
  count: number
  /** Cards inside this frame that belong to another workspace (position-only). */
  foreignCount?: number
  width: number
  height: number
  colorTag?: string
}

export type WsFrameNodeType = Node<WsFrameData, 'wsFrame'>

/** Thickness of the invisible drag strip along each dashed edge (px). */
const EDGE = 20

function WsFrame(props: NodeProps<WsFrameNodeType>): React.JSX.Element {
  const { data, selected } = props
  const color = colorOf(data.colorTag)
  return (
    <div
      className={`${styles['wsFrame']}${selected === true ? ` ${styles['wsFrameSelected']}` : ''}`}
      style={{
        width: data.width,
        height: data.height,
        ...(color !== undefined ? { borderColor: color.border, background: color.faint } : {}),
      }}
      data-talkmap-frame=""
    >
      <div
        className={styles['wsFrameLabel']}
        style={color !== undefined
          ? { borderColor: color.border, backgroundImage: `linear-gradient(${color.fill}, ${color.fill})` }
          : {}}
      >
        {data.title}
        <span className={styles['wsFrameCount']}>{data.count}</span>
        {data.foreignCount !== undefined && data.foreignCount > 0
          ? (
              <span
                className={styles['wsFrameForeign']}
                title={t('frame.foreignHint', { n: String(data.foreignCount) })}
              >
                {t('frame.foreign', { n: String(data.foreignCount) })}
              </span>
            )
          : null}
      </div>
      {/* border strips: clickable/draggable surfaces along the dashed edge */}
      <div className={styles['wsFrameEdge']} style={{ top: 0, left: 0, right: 0, height: EDGE }} />
      <div className={styles['wsFrameEdge']} style={{ bottom: 0, left: 0, right: 0, height: EDGE }} />
      <div className={styles['wsFrameEdge']} style={{ top: 0, bottom: 0, left: 0, width: EDGE }} />
      <div className={styles['wsFrameEdge']} style={{ top: 0, bottom: 0, right: 0, width: EDGE }} />
    </div>
  )
}

/** Frames only re-render when their geometry/counts really change. */
export const WsFrameNode = memo(WsFrame)
