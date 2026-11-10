/**
 * Image node: a picture dragged out of the drawer conversation onto the board.
 * The bytes live in the host store (content-addressed, served under
 * /talk-map/images/); this node only renders the image and carries its board
 * geometry. Resizing is proportional (keepAspectRatio) and persisted as the
 * node's width/height.
 */
import { memo } from 'react'
import { NodeResizer, type NodeProps, type Node } from '@xyflow/react'
import type { MapImage } from '../shared/model.ts'
import styles from './talk-map.module.css'

export interface ImageNodeData extends Record<string, unknown> {
  image: MapImage
  onResize: (id: string, width: number, height: number) => void
}

export type ImageNodeType = Node<ImageNodeData, 'imageNode'>

function ImageNode(props: NodeProps<ImageNodeType>): React.JSX.Element {
  const { id, data, selected } = props
  const { image } = data
  const classes = [styles['imageCard'] ?? '']
  if (selected === true) classes.push(styles['imageCardSelected'] ?? '')
  return (
    <div className={classes.join(' ')}>
      <NodeResizer
        isVisible={selected === true}
        keepAspectRatio
        minWidth={120}
        minHeight={80}
        onResize={(_event, params) => { data.onResize(id, params.width, params.height) }}
      />
      <img
        className={styles['imageCardImg']}
        src={image.src}
        alt={image.title ?? ''}
        draggable={false}
      />
    </div>
  )
}

export const ImageNodeView = memo(ImageNode)
