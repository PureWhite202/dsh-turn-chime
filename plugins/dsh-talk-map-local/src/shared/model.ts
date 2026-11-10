/**
 * Canvas-domain data model shared by both halves. The host side's zod
 * schemas (src/host/store.ts) are the durable source of truth; these plain
 * interfaces mirror them for the browser bundle (which must not pull zod).
 */

export interface Card {
  boardId: string
  sessionId: string
  x: number
  y: number
  colorTag?: string
  /** Map-level group override — the canvas's own organizational layer. */
  wsOverride?: string
  createdAt: number
}

export interface Board {
  name: string
  color: string
  order: number
  createdAt: number
  archivedAt?: number
  shelvedAt?: number
}

export interface EdgeInjection {
  /** 'link' = plain association between existing cards; 'none' = fork edge
   * whose child inherited nothing. */
  kind: 'digest' | 'full' | 'selection' | 'none' | 'link'
  injectedText?: string
}

export interface MapEdgeData {
  boardId: string
  fromCardId: string
  toCardId: string
  injection: EdgeInjection
  /** Handle sides ('t'|'r'|'b'|'l'); absent = legacy r→l. */
  fromHandle?: string
  toHandle?: string
  /** Pipe mode: source digest changes auto-push along this edge. */
  autoSync?: boolean
  /** Source-session title snapshot for host-side auto-sync headers. */
  fromTitle?: string
  createdAt: number
}

export interface Digest {
  atSeq: number
  summary: string
  keyFindings: string[]
  nextStep: string
  todoNext?: string
  generatedAt: number
  model?: string
  error?: string
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface ArchivedCardPlacement {
  cardId: string
  card: Card
  edges: Record<string, MapEdgeData>
}

export interface MapGlobal {
  version: number
  activeBoard: string
  cameraByBoard: Record<string, Camera>
  /** Auto-placement generation; absent = v1 (pre-workspace-grouping). */
  layoutVersion?: number
  /** Per-workspace color tags for the group frames. */
  wsColors?: Record<string, string>
  /** Manually sized frames (resize handle); absent = auto-fit to members. */
  wsFrames?: Record<string, FrameGeometry>
  /** Map-toggle hotkey, e.g. "alt+KeyF" (modifiers + KeyboardEvent.code). */
  hotkey?: string
  /** Interface language; absent = 'auto' (follow dsh's <html lang>). */
  locale?: LocalePref
  /** Conversation drawer width in px (drag the drawer's left edge); absent =
   *  the responsive default from the stylesheet. */
  drawerWidth?: number
  /** Last known placement per session — re-imports restore the arrangement. */
  layoutMemory?: Record<string, LayoutMemoryEntry>
  /** Archived conversations keep their board placement (and edges) here: the
   *  card is removed from the board while archived and restored on unarchive. */
  archivedCards?: Record<string, ArchivedCardPlacement>
}

/** Language the map's own copy renders in; 'auto' defers to dsh. */
export type LocalePref = 'auto' | 'zh' | 'en'

export interface LayoutMemoryEntry {
  x: number
  y: number
  colorTag?: string
}

export interface FrameGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface MapImage {
  boardId: string
  /** Stable plugin-served URL (/talk-map/images/<sha>). */
  src: string
  title?: string
  x: number
  y: number
  width: number
  height: number
  createdAt: number
}

export interface MapStatePayload {
  boards: Record<string, Board>
  cards: Record<string, Card>
  edges: Record<string, MapEdgeData>
  digests: Record<string, Digest>
  images: Record<string, MapImage>
  global: MapGlobal
}

export const INBOX_BOARD_ID = 'inbox'
