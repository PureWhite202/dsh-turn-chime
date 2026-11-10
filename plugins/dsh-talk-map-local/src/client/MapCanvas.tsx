/**
 * The board. Import-based: nothing lands here automatically — the user
 * imports a workspace (frame + its sessions as cards), imports single
 * conversations, or creates new ones on the canvas (draft card / fork edge).
 *
 * Cards drag freely; a group's frame is derived from its members and
 * stretches after them. Dragging the frame (label chip or border) carries
 * every member. Membership MIRRORS the sidebar: dsh binds a session to the
 * workspace whose directory it works in (immutable cwd), so the map offers
 * no group-moving — what the sidebar cannot do, the map does not pretend to.
 *
 * Interaction: right/middle-drag pans, plain right-click opens the context
 * menu, left-drag box-selects on the pane and drags nodes. The menu waits for
 * the right-button release (Chromium raises `contextmenu` on the press), so a
 * right-drag never opens it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Background, BackgroundVariant, ConnectionMode, ControlButton, Controls, ReactFlow, ReactFlowProvider,
  SelectionMode, useReactFlow, type Connection, type Edge, type EdgeChange, type FinalConnectionState,
  type NodeChange, type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { RootSlotStandardProps, SessionListState, WorkspaceListState } from './dsh.ts'
import type { ArchivedCardPlacement, Card, FrameGeometry, MapEdgeData } from '../shared/model.ts'
import { canvas, INBOX_BOARD_ID, newCardId, type CanvasState } from './canvas-store.ts'
import { COLOR_TAGS } from './colors.ts'
import { buildPushText, digestIsEmpty } from './digest-text.ts'
import { getServices, mapUi, openSessionInMain, sessionIdOf, unwrapRemote, useArchivedSessionIds, subscribeMapNotice, getMapNotice, clearMapNotice } from './map-state.ts'
import { addSessionCard, ensureWorkspaceFrame, preferredAgentPreset } from './map-create.ts'
import { newChatCardPosition, newConversationWorkspace } from './new-chat.ts'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu.tsx'
import { InteractionMenu } from './InteractionMenu.tsx'
import { completions, interactions, interactionMenu } from './interactions.ts'
import { DraftCardNode, type DraftCardData, type DraftCardNodeType, type DraftParent } from './DraftCard.tsx'
import { ImageNodeView, type ImageNodeType } from './ImageNode.tsx'
import { SessionCardNode, relativeTime, type SessionCardData, type SessionCardNodeType } from './SessionCard.tsx'
import { WsFrameNode, type WsFrameData, type WsFrameNodeType } from './WsFrame.tsx'
import { activeLocale, subscribeLocale, t } from './i18n.ts'
import { talkMapApi, type ApiError } from './api.ts'
import { useDsDarkTheme } from './use-dark.ts'
import styles from './talk-map.module.css'

const nodeTypes = { sessionCard: SessionCardNode, wsFrame: WsFrameNode, draftCard: DraftCardNode, imageNode: ImageNodeView }

const GRID = 16
const CARD_W = 250
const CARD_H = 120
const GAP_X = 48
const GAP_Y = 56
const COLS = 3
const FRAME_PAD = 32
const FRAME_LABEL_H = 30
const LAYOUT_VERSION = 3
/**
 * Pointer travel (px) that still counts as a click rather than a drag. Used
 * twice: a right drag past it is a pan (no menu), and a left drag past it is
 * no longer a card click. The board snaps to a 16px grid, so a sub-slop drag
 * never actually moves a card.
 */
const POINTER_CLICK_SLOP = 5

type TalkMapNode = SessionCardNodeType | WsFrameNodeType | DraftCardNodeType | ImageNodeType

/** Shallow compare of the fields a SessionCard renders — the node cache reuses
 *  the previous node object (and thus skips the card's render) while equal. */
function sameSessionCardData(left: SessionCardData, right: SessionCardData): boolean {
  return left.cardId === right.cardId
    && left.sessionId === right.sessionId
    && left.title === right.title
    && left.running === right.running
    && left.ghost === right.ghost
    && left.updatedAt === right.updatedAt
    && left.colorTag === right.colorTag
    && left.timeLabel === right.timeLabel
    && left.waiting === right.waiting
    && left.done === right.done
    && left.foreignLabel === right.foreignLabel
    && left.foreignTouch === right.foreignTouch
}

/** Same idea for frames: geometry/counts/colors are the whole render input. */
function sameWsFrameData(left: WsFrameData, right: WsFrameData): boolean {
  return left.workspaceId === right.workspaceId
    && left.title === right.title
    && left.count === right.count
    && left.foreignCount === right.foreignCount
    && left.width === right.width
    && left.height === right.height
    && left.colorTag === right.colorTag
}

/** Bottom toast. With an action it stays longer and is clickable (undo). */
interface ToastState {
  message: string
  actionLabel?: string
  onAction?: () => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function snap(value: number): number {
  return Math.round(value / GRID) * GRID
}

/** Sessions eligible for a card: top-level, non-empty logs. */
function placeableSessionIds(sessions: SessionListState): string[] {
  return sessions.ids.filter((id) => {
    const summary = sessions.byId[id]
    return summary !== undefined && !summary.blank && summary.origin !== 'subagent'
  })
}

function sessionWorkspaceIndex(workspaces: WorkspaceListState): Map<string, string> {
  const index = new Map<string, string>()
  for (const workspace of workspaces.items) {
    for (const sessionId of workspace.sessionIds) index.set(sessionId, workspace.workspaceId)
  }
  return index
}

function gridPosition(origin: { x: number; y: number }, index: number): { x: number; y: number } {
  const column = index % COLS
  const row = Math.floor(index / COLS)
  return {
    x: snap(origin.x + column * (CARD_W + GAP_X)),
    y: snap(origin.y + row * (CARD_H + GAP_Y)),
  }
}

/** Frame rect that fits a set of member cards. Cards grow with content, so
 * the rendered height (when known) replaces the layout constant. */
function fitRect(members: Card[], heightOf?: (index: number) => number): FrameGeometry {
  const height = (index: number): number => heightOf?.(index) ?? CARD_H
  const minX = Math.min(...members.map(card => card.x))
  const minY = Math.min(...members.map(card => card.y))
  const maxX = Math.max(...members.map(card => card.x + CARD_W))
  const maxY = Math.max(...members.map((card, index) => card.y + height(index)))
  return {
    x: minX - FRAME_PAD,
    y: minY - FRAME_PAD - FRAME_LABEL_H,
    width: maxX - minX + FRAME_PAD * 2,
    height: maxY - minY + FRAME_PAD * 2 + FRAME_LABEL_H,
  }
}


interface DraftState {
  x: number
  y: number
  workspaceId?: string
  groupId?: string
  /** Source card when the draft was dragged out of a connection point. */
  parent?: DraftParent
}

interface MenuContext {
  left: number
  top: number
  flowX: number
  flowY: number
  kind: 'pane' | 'card' | 'frame' | 'edge'
  targetId?: string
  /** Edge menus: endpoint card ids (set for stored AND lineage edges). */
  edgeFrom?: string
  edgeTo?: string
  view: 'root' | 'import-ws' | 'import-session' | 'new-ws'
}

/** Where/what a contextmenu event should open, before the panel is shown. */
type MenuRequest = Omit<MenuContext, 'view'>

/** A right-button press in flight; `moved` latches once past the click slop. */
interface RightGesture {
  x: number
  y: number
  moved: boolean
  pressed: boolean
}

/** Props of the board; the overlay adds the drawer opener. */
export interface MapCanvasProps extends RootSlotStandardProps {
  /** Single-clicked card: open that Session beside the map (right drawer). */
  onOpenChat?: (sessionId: string) => void
  /** Session currently shown in the drawer: it is being read, so its card
   *  never renders the "finished, unread" dot while the drawer holds it. */
  activeChatSessionId?: string
  /** Double-clicked card: open it full screen; the overlay owns the order. */
  onOpenSession?: (sessionId: string) => void
}

/** Directory part of a workspace path, lower-cased (both separators). */
function workspaceDirectoryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).toLowerCase()
}

/**
 * The deployment's default workspace never gets a frame: cards that belong to
 * no frame ARE its members. Matched by the shipped title or directory name.
 */
function isDefaultWorkspaceItem(item: { title: string; path: string }): boolean {
  return item.title.trim().toLowerCase() === 'default-workspace'
    || workspaceDirectoryName(item.path) === 'default-workspace'
}

function CanvasInner(props: MapCanvasProps): React.JSX.Element {  const dark = useDsDarkTheme()
  const canvasState = useSyncExternalStore(canvas.subscribe, canvas.get)
  const sessions = props.useSessions(state => state)
  const workspaces = props.useWorkspaces(state => state)
  const archivedIds = useArchivedSessionIds()
  // Live pending interactions (approvals / questions / plan reviews) per
  // Session, and the popover opened from a card's "needs you" button.
  const pendingInteractions = useSyncExternalStore(interactions.subscribe, interactions.getSnapshot)
  const completedIds = useSyncExternalStore(completions.subscribe, completions.getSnapshot)
  const interactionMenuState = useSyncExternalStore(interactionMenu.subscribe, interactionMenu.get)
  const { screenToFlowPosition, zoomTo } = useReactFlow()
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set())
  // Connection drag in flight → every card shows its (otherwise hidden)
  // connection points, so drop targets are visible.
  const [connecting, setConnecting] = useState(false)
  // Esc pressed mid-drag: swallow the following release so the spawn panel
  // does not pop on a gesture the user just cancelled.
  const connectCancelledRef = useRef(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [menu, setMenu] = useState<MenuContext | null>(null)
  const framePosRef = useRef<Record<string, { x: number; y: number }>>({})
  // Single-click opens the side drawer only after the double-click window:
  // opening it on the first click used to remove the card under the pointer,
  // so the second click landed on the pane and spawned a draft card.
  const chatOpenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelChatSoon = (): void => {
    if (chatOpenTimer.current === undefined) return
    clearTimeout(chatOpenTimer.current)
    chatOpenTimer.current = undefined
  }
  const openChatSoon = (sessionId: string): void => {
    cancelChatSoon()
    chatOpenTimer.current = setTimeout(() => {
      chatOpenTimer.current = undefined
      props.onOpenChat?.(sessionId)
    }, 220)
  }
  useEffect(() => () => { cancelChatSoon() }, [])

  /** Card whose on-screen rectangle contains the point, if any. */
  const cardAtClientPoint = (x: number, y: number): string | undefined => {
    for (const cardId of Object.keys(visibleCards)) {
      const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(cardId)}"]`)
      if (node === null) continue
      const rect = node.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return cardId
    }
    return undefined
  }

  // Chromium raises `contextmenu` on the right-button PRESS — before the
  // pointer has travelled — so the menu cannot be opened there: a right-drag
  // pan would open it too (the board listens to the raw event, so React Flow
  // never gets to withhold it). Hold the request and let the release tell a
  // click from a drag. Engines that raise `contextmenu` on the RELEASE decide
  // right in the handler; both paths share the press tracking below.
  const rightGesture = useRef<RightGesture | null>(null)
  const pendingMenu = useRef<MenuRequest | null>(null)

  /** What the menu should show for a contextmenu event, if anything. */
  const menuRequest = (event: React.MouseEvent): MenuRequest | null => {
    const wrapper = wrapperRef.current
    if (wrapper === null) return null
    const target = event.target as HTMLElement
    const geometry = (): Pick<MenuContext, 'left' | 'top' | 'flowX' | 'flowY'> => {
      const bounds = wrapper.getBoundingClientRect()
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      return {
        left: event.clientX - bounds.left,
        top: event.clientY - bounds.top,
        flowX: flow.x,
        flowY: flow.y,
      }
    }
    // Edges keep their own menu: the DOM carries the id, and the endpoints
    // ride on our edge data (card ids contain dashes — the id is not parsable).
    const edgeNode = target.closest('.react-flow__edge')
    if (edgeNode !== null) {
      const edgeId = edgeNode.getAttribute('data-id')
      if (edgeId === null || edgeId === '') return null
      const data = edges.find(edge => edge.id === edgeId)?.data as
        | { fromCardId?: string; toCardId?: string }
        | undefined
      if (data?.fromCardId === undefined || data.toCardId === undefined) return null
      return { ...geometry(), kind: 'edge', targetId: edgeId, edgeFrom: data.fromCardId, edgeTo: data.toCardId }
    }
    const cardNode = target.closest('.react-flow__node[data-id^="card-"]')
    if (cardNode !== null) {
      const cardId = cardNode.getAttribute('data-id')
      if (cardId === null || cardId === '') return null
      return { ...geometry(), kind: 'card', targetId: cardId }
    }
    const frameNode = target.closest('.react-flow__node[data-id^="frame-"]')
    if (frameNode !== null) {
      const frameId = frameNode.getAttribute('data-id')?.slice('frame-'.length)
      if (frameId === undefined || frameId === '') return null
      return { ...geometry(), kind: 'frame', targetId: frameId }
    }
    // Other nodes (the draft card) own no menu; overlay UI is not the pane.
    if (target.closest('.react-flow__node') !== null) return null
    if (target.closest('.react-flow__pane') === null) return null
    return { ...geometry(), kind: 'pane' }
  }

  const openMenu = useCallback((request: MenuRequest): void => {
    setMenu({ ...request, view: 'root' })
  }, [])

  const handleContextMenu = (event: React.MouseEvent): void => {
    // Always swallow the native menu — this board owns its own.
    event.preventDefault()
    const request = menuRequest(event)
    if (request === null) return
    // Non-right triggers (keyboard, macOS ctrl+click) never pan: open now.
    if (event.button !== 2) {
      openMenu(request)
      return
    }
    const gesture = rightGesture.current
    if (gesture !== null && gesture.pressed) {
      // Chromium: the press is still down, so this may yet become a drag.
      pendingMenu.current = request
      return
    }
    // Some engines raise contextmenu on the release: the press is over, so
    // the tracked gesture already knows whether the pointer travelled.
    rightGesture.current = null
    pendingMenu.current = null
    if (gesture === null || !gesture.moved) openMenu(request)
  }
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Window-level press tracking (capture phase): React Flow's pane drag grabs
  // the pointer for the pan, so wrapper-level move handlers are not guaranteed
  // to fire, and capture keeps this ahead of handlers that stop propagation.
  useEffect(() => {
    const withinMap = (target: EventTarget | null): boolean => {
      const wrapper = wrapperRef.current
      return wrapper !== null && target instanceof Node && wrapper.contains(target)
    }
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 2) return
      pendingMenu.current = null
      rightGesture.current = withinMap(event.target)
        ? { x: event.clientX, y: event.clientY, moved: false, pressed: true }
        : null
    }
    const onMove = (event: PointerEvent): void => {
      const gesture = rightGesture.current
      if (gesture === null || !gesture.pressed || gesture.moved) return
      if (
        Math.abs(event.clientX - gesture.x) > POINTER_CLICK_SLOP
        || Math.abs(event.clientY - gesture.y) > POINTER_CLICK_SLOP
      ) gesture.moved = true
    }
    const onUp = (event: PointerEvent): void => {
      if (event.button !== 2) return
      const gesture = rightGesture.current
      if (gesture !== null) gesture.pressed = false
      const request = pendingMenu.current
      pendingMenu.current = null
      // The contextmenu that arrived on the press left this pending: open it
      // now unless the pointer travelled — that gesture was a right-drag pan.
      if (request !== null && (gesture === null || !gesture.moved)) openMenu(request)
    }
    const onCancel = (): void => {
      rightGesture.current = null
      pendingMenu.current = null
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('blur', onCancel)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('blur', onCancel)
    }
  }, [openMenu])

  // While a rubber-band drag is running, the node/edge arrays are frozen:
  // a mid-drag data refresh (digest SSE, running-state flip) re-renders the
  // flow and corrupts React Flow's in-flight hit testing — the intermittent
  // "one small box selects everything / selects nothing" reports.
  const [isSelecting, setIsSelecting] = useState(false)
  const frozenRef = useRef<{ nodes: TalkMapNode[]; edges: Edge[] } | null>(null)
  // React Flow node-object cache: unchanged cards/frames keep their previous
  // node object, so React Flow (and memo() on the card) skips their renders.
  const nodeCacheRef = useRef<Map<string, TalkMapNode>>(new Map())
  // React Flow rebuilds its internal node whenever the node OBJECT we pass
  // changes, and that copy takes `measured` from the object itself. A rebuilt
  // card without `measured` renders `visibility: hidden` until the next resize
  // observation — a one-frame window where pointer events fall through to the
  // pane. Dragging rebuilds on every position change, so releasing inside that
  // window made a card click do nothing ("needs a second click"). Mirror the
  // measured sizes from React Flow's dimension changes back onto rebuilt nodes.
  const measuredRef = useRef<Map<string, { width: number; height: number }>>(new Map())
  // The cards render a relative "5分钟" label; a minute tick re-renders them
  // even when nothing else changed (the node cache includes this bucket).
  const [nowMinute, setNowMinute] = useState(() => Math.floor(Date.now() / 60_000))
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMinute(Math.floor(Date.now() / 60_000))
    }, 60_000)
    return () => { clearInterval(timer) }
  }, [])

  // Copy inside React Flow nodes is memoised by the flow itself, so a
  // language switch has to invalidate the memos that build them — hence
  // `locale` in their dependency lists below.
  const locale = useSyncExternalStore(subscribeLocale, activeLocale, activeLocale)

  // A draft box is open in the middle of the map. Keep its node data (and
  // callbacks) referentially stable so map/session updates do not re-render
  // the open form; only the draft itself changing (position/parent) does.
  const draftWorkspaceOptions = useMemo(
    () => workspaces.items.map(item => ({ id: item.workspaceId, title: item.title, path: item.path })),
    [workspaces.items],
  )
  const closeDraft = useCallback(() => { setDraft(null) }, [])
  const draftNodeData = useMemo<DraftCardData | null>(() => {
    if (draft === null) return null
    return {
      workspaceOptions: draftWorkspaceOptions,
      ...(draft.workspaceId !== undefined ? { defaultWorkspaceId: draft.workspaceId } : {}),
      ...(draft.groupId !== undefined ? { groupId: draft.groupId } : {}),
      ...(draft.parent !== undefined ? { parent: draft.parent } : {}),
      onClose: closeDraft,
      ...(props.onOpenChat !== undefined ? { onOpenChat: props.onOpenChat } : {}),
    }
  }, [draft, draftWorkspaceOptions, closeDraft, props.onOpenChat])

  const sessionWs = useMemo(() => sessionWorkspaceIndex(workspaces), [workspaces])
  const wsTitles = useMemo(
    () => new Map(workspaces.items.map(item => [item.workspaceId, item.title])),
    [workspaces],
  )
  // The shipped default workspace's title is its directory name; show the
  // same friendly label the sidebar uses.
  const wsDisplayNames = useMemo(() => {
    const out = new Map<string, string>()
    for (const item of workspaces.items) {
      const base = item.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase()
      out.set(item.workspaceId, base === 'default-workspace' ? t('frame.defaultWs') : item.title)
    }
    return out
  }, [workspaces.items, locale])
  /** Bare cards (no frame) are the default workspace's members. */
  const defaultWorkspaceId = useMemo(
    () => workspaces.items.find(isDefaultWorkspaceItem)?.workspaceId,
    [workspaces.items],
  )
  const workspacesReady = workspaces.baselinesReady !== false

  const wsFrames = canvasState.global?.wsFrames ?? {}
  const wsColors = useMemo(
    () => canvasState.global?.wsColors ?? {},
    [canvasState.global?.wsColors],
  )
  const layoutVersion = canvasState.global?.layoutVersion ?? 1

  // Migration v3 → the import-based world: existing cards keep their spots,
  // get explicit group membership stamped from the sidebar accounting, and
  // every populated group gets a stored frame. Runs once.
  useEffect(() => {
    if (canvasState.phase !== 'ready' || layoutVersion >= LAYOUT_VERSION || !workspacesReady) return
    const byGroup = new Map<string, Card[]>()
    for (const card of Object.values(canvasState.cards)) {
      const groupId = sessionWs.get(card.sessionId)
      if (groupId === undefined) continue
      byGroup.set(groupId, [...byGroup.get(groupId) ?? [], card])
    }
    const framesNext = { ...canvasState.global?.wsFrames }
    for (const [groupId, members] of byGroup) {
      if (groupId === defaultWorkspaceId) continue
      if (framesNext[groupId] === undefined && members.length > 0) {
        framesNext[groupId] = fitRect(members)
      }
    }
    canvas.patchGlobalNow({ layoutVersion: LAYOUT_VERSION, wsFrames: framesNext })
  }, [canvasState.phase, layoutVersion, workspacesReady, canvasState.cards, canvasState.global, sessionWs, defaultWorkspaceId])

  // The default workspace is represented by bare canvas cards; drop a frame
  // an older release may have created for it. Its cards stay exactly where
  // they are — they just stop being framed.
  useEffect(() => {
    if (defaultWorkspaceId === undefined) return
    if (wsFrames[defaultWorkspaceId] === undefined) return
    canvas.removeWsFrame(defaultWorkspaceId)
  }, [defaultWorkspaceId, wsFrames])

  // Cards pointing at blank (empty-log) sessions are noise. A stable blank-id
  // key keeps this list identical across session ticks that don't actually
  // change any card's blank state.
  const blankSessionsKey = useMemo(() => {
    const ids: string[] = []
    for (const id of sessions.ids) if (sessions.byId[id]?.blank === true) ids.push(id)
    ids.sort()
    return ids.join('|')
  }, [sessions])
  const blankSessions = useMemo(
    () => new Set(blankSessionsKey === '' ? [] : blankSessionsKey.split('|')),
    [blankSessionsKey],
  )
  const visibleCards = useMemo(() => {
    const out: Record<string, Card> = {}
    for (const [cardId, card] of Object.entries(canvasState.cards)) {
      if (blankSessions.has(card.sessionId)) continue
      // Archiving a conversation (sidebar or the card menu) removes its node
      // from the board; the placement survives so unarchiving brings it back.
      if (archivedIds.has(card.sessionId)) continue
      out[cardId] = card
    }
    return out
  }, [canvasState.cards, blankSessions, archivedIds])
  // Stable id set: dragging changes positions (a new visibleCards object every
  // frame) but not this key, so the height observer does not reattach per move.
  const cardIdsKey = useMemo(() => Object.keys(visibleCards).sort().join('|'), [visibleCards])

  // Archive <-> board placement bridge. Archiving a Session (sidebar or card
  // menu) removes its card from the board and remembers the placement in the
  // global store; unarchiving restores the card and its edges exactly where
  // they were. The sidebar archive never touches the map, so this is the one
  // place that reconciles the two.
  useEffect(() => {
    if (canvasState.global === null) return
    const placements = canvasState.global.archivedCards ?? {}
    let nextPlacements: Record<string, ArchivedCardPlacement> = placements
    const toRemove: string[] = []
    const toRestore: ArchivedCardPlacement[] = []
    let moved = false
    for (const [cardId, card] of Object.entries(canvasState.cards)) {
      if (!archivedIds.has(card.sessionId)) continue
      const edges = Object.fromEntries(
        Object.entries(canvasState.edges).filter(([, edge]) => edge.fromCardId === cardId || edge.toCardId === cardId),
      )
      nextPlacements = { ...nextPlacements, [card.sessionId]: { cardId, card, edges } }
      toRemove.push(cardId)
      moved = true
    }
    for (const [sessionId, placement] of Object.entries(nextPlacements)) {
      if (archivedIds.has(sessionId)) continue
      const remaining = { ...nextPlacements }
      delete remaining[sessionId]
      nextPlacements = remaining
      toRestore.push(placement)
      moved = true
    }
    if (!moved) return
    canvas.patchGlobalNow({ archivedCards: nextPlacements })
    for (const cardId of toRemove) canvas.removeCard(cardId)
    for (const placement of toRestore) {
      canvas.addCards({ [placement.cardId]: placement.card })
      if (Object.keys(placement.edges).length > 0) canvas.addEdges(placement.edges)
    }
  }, [archivedIds, canvasState.cards, canvasState.edges, canvasState.global])

  // Membership mirrors the sidebar truth: a card belongs to its session's
  // real workspace (dsh binds that to the session's cwd; sessions cannot
  // move between workspaces, so neither do cards between frames).
  const membersByGroup = useMemo(() => {
    const index = new Map<string, string[]>()
    for (const [cardId, card] of Object.entries(visibleCards)) {
      const groupId = sessionWs.get(card.sessionId)
      if (groupId === undefined) continue
      const members = index.get(groupId)
      if (members === undefined) index.set(groupId, [cardId])
      else members.push(cardId)
    }
    return index
  }, [visibleCards, sessionWs])

  // The CSS card grows with its content (min-height is a floor), so the frame
  // fitting must use the measured node height — CARD_H would let tall cards
  // sit on the dashed border.
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({})
  useEffect(() => {
    const measure = (): void => {
      const next: Record<string, number> = {}
      for (const element of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="card-"]')) {
        const dataId = element.getAttribute('data-id')
        if (dataId === null || !dataId.startsWith('card-')) continue
        const height = element.offsetHeight
        if (height > 0) next[dataId] = height
      }
      setCardHeights((previous) => {
        const keys = Object.keys(next)
        if (keys.length === Object.keys(previous).length && keys.every(key => previous[key] === next[key])) return previous
        return next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const node of document.querySelectorAll('.react-flow__node[data-id^="card-"]')) observer.observe(node)
    const raf = requestAnimationFrame(measure)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [cardIdsKey, locale])

  // Frame geometry FOLLOWS its members (free dragging stretches the frame);
  // the stored rect only positions a group that currently has no cards.
  const frameGeometry = useMemo(() => {
    const out: Record<string, FrameGeometry> = {}
    for (const [groupId, stored] of Object.entries(wsFrames)) {
      const memberIds = (membersByGroup.get(groupId) ?? []).filter(id => visibleCards[id] !== undefined)
      const members = memberIds.map(id => visibleCards[id] as Card)
      out[groupId] = members.length > 0
        ? fitRect(members, (index) => cardHeights[memberIds[index] as string] ?? CARD_H)
        : stored
    }
    return out
  }, [wsFrames, membersByGroup, visibleCards, cardHeights])

  // Cards resting inside a frame of ANOTHER workspace: membership is fixed
  // by the Session's real workspace, so the map only flags the mismatch.
  // Touching (or crossing) the dashed border is a second, louder state.
  const foreign = useMemo(() => {
    const labels = new Map<string, string>()
    const counts = new Map<string, number>()
    const touching = new Set<string>()
    const TOUCH = 8
    for (const [groupId, rect] of Object.entries(frameGeometry)) {
      const frameRight = rect.x + rect.width
      const frameBottom = rect.y + rect.height
      for (const [cardId, card] of Object.entries(visibleCards)) {
        const own = sessionWs.get(card.sessionId)
        if (own === undefined || own === groupId) continue
        const height = cardHeights[cardId] ?? CARD_H
        const cardRight = card.x + CARD_W
        const cardBottom = card.y + height
        if (card.x > frameRight + TOUCH || cardRight < rect.x - TOUCH) continue
        if (card.y > frameBottom + TOUCH || cardBottom < rect.y - TOUCH) continue
        const centerX = card.x + CARD_W / 2
        const centerY = card.y + height / 2
        const centerInside = centerX > rect.x && centerX < frameRight && centerY > rect.y && centerY < frameBottom
        const touchesBorder =
          (cardRight >= rect.x - TOUCH && card.x <= rect.x + TOUCH) ||
          (cardRight >= frameRight - TOUCH && card.x <= frameRight + TOUCH) ||
          (cardBottom >= rect.y - TOUCH && card.y <= rect.y + TOUCH) ||
          (cardBottom >= frameBottom - TOUCH && card.y <= frameBottom + TOUCH)
        if (!centerInside && !touchesBorder) continue
        labels.set(cardId, wsDisplayNames.get(own) ?? t('frame.unknown'))
        counts.set(groupId, (counts.get(groupId) ?? 0) + 1)
        if (touchesBorder) touching.add(cardId)
      }
    }
    return { labels, counts, touching }
  }, [frameGeometry, visibleCards, sessionWs, wsDisplayNames, cardHeights, locale])

  useEffect(() => {
    framePosRef.current = Object.fromEntries(
      Object.entries(frameGeometry).map(([groupId, rect]) => [`frame-${groupId}`, { x: rect.x, y: rect.y }]),
    )
  }, [frameGeometry])

  // While a connection drag is live, Esc belongs to it. React Flow (this
  // @xyflow version) has NO Escape handling of its own and exposes no
  // cancelConnection API — the ghost line follows the pointer until
  // release regardless. So Esc only arms the cancel flag; the drag state
  // (handles revealed, Esc claimed) deliberately survives until pointerup,
  // matching the still-visible ghost line and keeping a second Esc from
  // falling through to the overlay and closing the map. onConnect and
  // onConnectEnd both honor the flag, so a cancelled gesture creates
  // nothing no matter where it is released.
  useEffect(() => {
    if (!connecting) return
    const release = mapUi.claimEscape('connecting')
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') connectCancelledRef.current = true
    }
    // pointercancel/blur too: a gesture the browser aborts (system touch
    // gesture, tab switch) never produces a pointerup, and a connecting
    // state that cannot exit would hold the Esc claim forever.
    const onGestureEnd = (): void => { setConnecting(false) }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerup', onGestureEnd, { capture: true })
    window.addEventListener('pointercancel', onGestureEnd, { capture: true })
    window.addEventListener('blur', onGestureEnd)
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('pointerup', onGestureEnd, { capture: true })
      window.removeEventListener('pointercancel', onGestureEnd, { capture: true })
      window.removeEventListener('blur', onGestureEnd)
      release()
    }
  }, [connecting])

  // Cmd/Ctrl+Z undoes board operations (Shift redoes); text fields keep
  // their native undo.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.code !== 'KeyZ') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]') !== null && target !== null) return
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) canvas.redo()
      else canvas.undo()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => { window.removeEventListener('keydown', onKeyDown, { capture: true }) }
  }, [])

  // With a selection active, Esc clears it instead of closing the map, and
  // Backspace/Delete removes selected FRAMES (React Flow no longer owns
  // frame selection, so its deleteKeyCode cannot reach them; cards stay on
  // the React Flow path).
  // Selection ids can go stale without a select:false ever firing — the
  // context menu and SSE delete straight from the store, and React Flow
  // emits no change for an element that simply vanished from a controlled
  // array. These existence-filtered sets are the ONLY selection surface
  // consumers may read (Backspace, the color toolbar, node/edge selected
  // flags): a dead id must neither pin hasSelection (swallowing Escape)
  // nor let an action fire against a deleted frame or card. Cards are
  // judged against visibleCards — a session turning blank drops its card
  // from the canvas while it lingers in the store.
  const liveSelectedIds = useMemo(() => {
    const next = new Set<string>()
    for (const id of selectedIds) {
      if (id.startsWith('frame-')) {
        if (wsFrames[id.slice('frame-'.length)] !== undefined) next.add(id)
      } else if (id.startsWith('image-')) {
        if (canvasState.images[id.slice('image-'.length)] !== undefined) next.add(id)
      } else if (visibleCards[id] !== undefined) {
        next.add(id)
      }
    }
    return next
  }, [selectedIds, visibleCards, wsFrames, canvasState.images])
  const liveSelectedEdgeIds = useMemo(() => {
    const next = new Set<string>()
    for (const id of selectedEdgeIds) {
      if (canvasState.edges[id] !== undefined) next.add(id)
    }
    return next
  }, [selectedEdgeIds, canvasState.edges])
  const hasSelection = liveSelectedIds.size > 0 || liveSelectedEdgeIds.size > 0
  // Keep the selection listener (re)registration to selection appear/disappear
  // instead of every render; the handler reads the latest ids through a ref.
  const liveSelectedIdsRef = useRef(liveSelectedIds)
  liveSelectedIdsRef.current = liveSelectedIds
  const removeGroupRef = useRef<(groupId: string) => void>(() => undefined)
  useEffect(() => {
    if (!hasSelection) return
    const release = mapUi.claimEscape('selection')
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setSelectedIds(new Set())
        setSelectedEdgeIds(new Set())
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const target = event.target as HTMLElement | null
        if (target !== null && target.closest('input, textarea, [contenteditable="true"]') !== null) return
        const frameIds = [...liveSelectedIdsRef.current].filter(id => id.startsWith('frame-'))
        const imageIds = [...liveSelectedIdsRef.current]
          .filter(id => id.startsWith('image-'))
          .map(id => id.slice('image-'.length))
        if (imageIds.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          canvas.removeImages(imageIds)
          setSelectedIds((previous) => {
            const next = new Set(previous)
            for (const id of previous) {
              if (id.startsWith('image-')) next.delete(id)
            }
            return next
          })
        }
        if (frameIds.length === 0) return
        for (const frameId of frameIds) removeGroupRef.current(frameId.slice('frame-'.length))
        setSelectedIds((previous) => {
          const next = new Set(previous)
          for (const frameId of frameIds) next.delete(frameId)
          return next
        })
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      release()
    }
  }, [hasSelection])

  const handleImageResize = useCallback((id: string, width: number, height: number): void => {
    canvas.resizeImage(id, width, height)
  }, [])

  const liveNodes = useMemo<TalkMapNode[]>(() => {
    // While a rubber-band selection is in flight the node array is frozen so a
    // mid-gesture re-render cannot corrupt React Flow's hit testing; skip the
    // rebuild entirely in that window.
    if (isSelecting && frozenRef.current !== null) return frozenRef.current.nodes
    const previousNodes = nodeCacheRef.current
    const nextCache = new Map<string, TalkMapNode>()
    const frameNodes: TalkMapNode[] = Object.entries(frameGeometry).map(([groupId, rect]) => {
      const id = `frame-${groupId}`
      const members = membersByGroup.get(groupId) ?? []
      const selected = liveSelectedIds.has(id)
      const data: WsFrameData = {
        workspaceId: groupId,
        title: wsTitles.get(groupId) ?? t('frame.unknown'),
        count: members.length,
        foreignCount: foreign.counts.get(groupId) ?? 0,
        width: rect.width,
        height: rect.height,
        ...(wsColors[groupId] !== undefined ? { colorTag: wsColors[groupId] } : {}),
      }
      const cached = previousNodes.get(id)
      if (
        cached !== undefined && cached.type === 'wsFrame'
        && cached.position.x === rect.x && cached.position.y === rect.y
        && cached.selected === selected
        && sameWsFrameData(cached.data, data)
      ) {
        nextCache.set(id, cached)
        return cached
      }
      const measured = measuredRef.current.get(id)
      const node: WsFrameNodeType = {
        id,
        type: 'wsFrame',
        position: { x: rect.x, y: rect.y },
        data,
        ...(measured !== undefined ? { measured } : {}),
        draggable: true,
        // NOT selectable by React Flow: rubber-band selection grows in
        // batches and would sweep the huge frames in. Frame selection is
        // click-only, managed by this component (onNodeClick).
        selectable: false,
        focusable: false,
        selected,
        zIndex: -1,
        style: { pointerEvents: 'none' as const },
      }
      nextCache.set(id, node)
      return node
    })
    const cardNodes: TalkMapNode[] = Object.entries(visibleCards)
      .filter(([, card]) => card.boardId === INBOX_BOARD_ID)
      .map(([cardId, card]) => {
        const summary = sessions.byId[card.sessionId]
        const selected = liveSelectedIds.has(cardId)
        const data: SessionCardData = {
          cardId,
          sessionId: card.sessionId,
          title: summary?.displayTitle ?? card.sessionId,
          running: summary?.running ?? false,
          ghost: summary === undefined,
          updatedAt: summary?.updatedAt,
          waiting: pendingInteractions.has(card.sessionId) || summary?.pendingInteraction !== undefined,
          done: completedIds.has(card.sessionId) && card.sessionId !== props.activeChatSessionId,
          ...(card.colorTag !== undefined ? { colorTag: card.colorTag } : {}),
          ...(foreign.labels.has(cardId) ? { foreignLabel: foreign.labels.get(cardId) } : {}),
          ...(foreign.touching.has(cardId) ? { foreignTouch: true } : {}),
          timeLabel: relativeTime(summary?.updatedAt),
        }
        const cached = previousNodes.get(cardId)
        if (
          cached !== undefined && cached.type === 'sessionCard'
          && cached.position.x === card.x && cached.position.y === card.y
          && cached.selected === selected
          && sameSessionCardData(cached.data, data)
        ) {
          nextCache.set(cardId, cached)
          return cached
        }
        const measured = measuredRef.current.get(cardId)
        const node: SessionCardNodeType = {
          id: cardId,
          type: 'sessionCard',
          position: { x: card.x, y: card.y },
          selected,
          ...(measured !== undefined ? { measured } : {}),
          data,
        }
        nextCache.set(cardId, node)
        return node
      })
    const draftNodes: TalkMapNode[] = draft === null || draftNodeData === null
      ? []
      : [{
          id: 'draft',
          type: 'draftCard' as const,
          position: { x: draft.x, y: draft.y },
          selectable: false,
          zIndex: 10,
          data: draftNodeData,
        }]
    const imageNodes: TalkMapNode[] = Object.entries(canvasState.images).map(([imageId, image]) => ({
      id: `image-${imageId}`,
      type: 'imageNode' as const,
      position: { x: image.x, y: image.y },
      width: image.width,
      height: image.height,
      data: { image, onResize: handleImageResize },
    }))
    nodeCacheRef.current = nextCache
    return [...frameNodes, ...imageNodes, ...cardNodes, ...draftNodes]
  }, [frameGeometry, membersByGroup, wsTitles, visibleCards, wsColors, sessions, liveSelectedIds, draft, draftNodeData, workspaces.items, locale, pendingInteractions, completedIds, foreign, archivedIds, nowMinute, isSelecting, props.onOpenChat, props.activeChatSessionId, canvasState.images, handleImageResize])

  const sessionIdToCardId = useMemo(() => {
    const index = new Map<string, string>()
    for (const [cardId, card] of Object.entries(visibleCards)) {
      if (!index.has(card.sessionId)) index.set(card.sessionId, cardId)
    }
    return index
  }, [visibleCards])

  // Lineage edges need only the parent link per Session; a narrow map keeps
  // them stable across session ticks that don't change any parent.
  const parentBySession = useMemo(() => {
    const index = new Map<string, string>()
    for (const id of sessions.ids) {
      const parentId = sessions.byId[id]?.parentId
      if (parentId !== undefined) index.set(id, parentId)
    }
    return index
  }, [sessions])

  const liveEdges = useMemo<Edge[]>(() => {
    const out: Edge[] = []
    const present = new Set(Object.keys(visibleCards))
    // Card pairs with an explicit user-drawn edge, registered in BOTH
    // directions: the derived lineage dashes yield to a stored edge no
    // matter which way it was drawn — otherwise the two lines overlap on
    // the same handles and a deleted edge looks like it survived.
    const explicitPairs = new Set<string>()
    for (const [edgeId, edge] of Object.entries(canvasState.edges)) {
      explicitPairs.add(`${edge.fromCardId}->${edge.toCardId}`)
      explicitPairs.add(`${edge.toCardId}->${edge.fromCardId}`)
      if (!present.has(edge.fromCardId) || !present.has(edge.toCardId)) continue
      const kind = edge.injection.kind
      out.push({
        id: edgeId,
        source: edge.fromCardId,
        target: edge.toCardId,
        // Handles stored per edge; legacy edges keep their old r→l anchoring.
        sourceHandle: edge.fromHandle ?? 'r',
        targetHandle: edge.toHandle ?? 'l',
        type: 'smoothstep',
        selected: liveSelectedEdgeIds.has(edgeId),
        // Endpoints ride along for the edge context menu (id parsing would
        // be ambiguous — card ids contain dashes).
        data: { fromCardId: edge.fromCardId, toCardId: edge.toCardId },
        // Pure association lines: no label, lighter than injection edges.
        ...(kind === 'link'
          ? { style: { opacity: 0.4 } }
          : {
              label: kind === 'none'
                ? t('edge.none')
                : kind === 'full'
                  ? t('edge.full')
                  : t('edge.injected'),
              ...(kind === 'none' ? { style: { opacity: 0.65 } } : {}),
            }),
      })
    }
    for (const [cardId, card] of Object.entries(visibleCards)) {
      const parentSessionId = parentBySession.get(card.sessionId)
      if (parentSessionId === undefined) continue
      const parentCardId = sessionIdToCardId.get(parentSessionId)
      if (parentCardId === undefined) continue
      if (explicitPairs.has(`${parentCardId}->${cardId}`)) continue
      out.push({
        id: `lineage-${parentCardId}-${cardId}`,
        source: parentCardId,
        target: cardId,
        sourceHandle: 'r',
        targetHandle: 'l',
        type: 'smoothstep',
        selectable: false,
        data: { fromCardId: parentCardId, toCardId: cardId },
        style: { strokeDasharray: '6 4', opacity: 0.5 },
      })
    }
    return out
  }, [visibleCards, canvasState.edges, parentBySession, sessionIdToCardId, liveSelectedEdgeIds, locale])

  const nodes = isSelecting && frozenRef.current !== null ? frozenRef.current.nodes : liveNodes
  const edges = isSelecting && frozenRef.current !== null ? frozenRef.current.edges : liveEdges

  const onSelectionStart = (): void => {
    frozenRef.current = { nodes: liveNodes, edges: liveEdges }
    setIsSelecting(true)
  }
  const onSelectionEnd = (): void => {
    frozenRef.current = null
    setIsSelecting(false)
  }

  const onNodesChange = (changes: NodeChange<TalkMapNode>[]): void => {
    const removedCardIds = changes
      .filter((change): change is Extract<NodeChange<TalkMapNode>, { type: 'remove' }> => change.type === 'remove')
      .map(change => change.id)
      .filter(id => !id.startsWith('frame-') && id !== 'draft' && !id.startsWith('image-'))
    // Collect every card move in this batch and commit once: a frame drag used
    // to copy the whole card map once per member (O(n²) per pointer move).
    const positionUpdates: Record<string, { x: number; y: number }> = {}
    const imagePositionUpdates: Record<string, { x: number; y: number }> = {}
    const removedImageIds = changes
      .filter((change): change is Extract<NodeChange<TalkMapNode>, { type: 'remove' }> => change.type === 'remove')
      .map(change => change.id)
      .filter(id => id.startsWith('image-'))
      .map(id => id.slice('image-'.length))
    for (const change of changes) {
      if (change.type === 'position' && change.position !== undefined) {
        if (change.id === 'draft') {
          setDraft(previous => previous === null
            ? previous
            : { ...previous, x: change.position?.x ?? previous.x, y: change.position?.y ?? previous.y })
        } else if (change.id.startsWith('frame-')) {
          const previous = framePosRef.current[change.id]
          const groupId = change.id.slice('frame-'.length)
          if (previous !== undefined) {
            const dx = change.position.x - previous.x
            const dy = change.position.y - previous.y
            if (dx !== 0 || dy !== 0) {
              for (const cardId of membersByGroup.get(groupId) ?? []) {
                const card = canvasState.cards[cardId]
                if (card !== undefined) positionUpdates[cardId] = { x: card.x + dx, y: card.y + dy }
              }
            }
          }
          framePosRef.current[change.id] = { x: change.position.x, y: change.position.y }
          const rect = wsFrames[groupId]
          if (rect !== undefined) {
            canvas.setWsFrameRect(groupId, {
              x: change.position.x,
              y: change.position.y,
              width: rect.width,
              height: rect.height,
            })
          }
        } else if (change.id.startsWith('image-')) {
          imagePositionUpdates[change.id.slice('image-'.length)] = { x: change.position.x, y: change.position.y }
        } else {
          // Free dragging — the frame stretches after its members.
          positionUpdates[change.id] = { x: change.position.x, y: change.position.y }
        }
      } else if (change.type === 'dimensions' && change.dimensions !== undefined) {
        measuredRef.current.set(change.id, {
          width: change.dimensions.width,
          height: change.dimensions.height,
        })
      } else if (change.type === 'select') {
        setSelectedIds((previous) => {
          const next = new Set(previous)
          if (change.selected) next.add(change.id)
          else next.delete(change.id)
          return next
        })
      } else if (change.type === 'remove') {
        // Backspace/Delete on a selection (React Flow ignores focused inputs).
        // Cards leave the map (the session itself is untouched); a frame
        // removal takes its member cards with it — same as the context menu.
        if (change.id.startsWith('frame-')) {
          removeGroup(change.id.slice('frame-'.length))
        } else if (change.id !== 'draft') {
          canvas.removeCard(change.id)
        }
        setSelectedIds((previous) => {
          const next = new Set(previous)
          next.delete(change.id)
          return next
        })
      }
    }
    if (Object.keys(positionUpdates).length > 0) canvas.moveCards(positionUpdates)
    if (Object.keys(imagePositionUpdates).length > 0) canvas.moveImages(imagePositionUpdates)
    if (removedImageIds.length > 0) canvas.removeImages(removedImageIds)
    // AFTER the removals (and after the first removeCard pushed the undo
    // snapshot with frames intact): a batch that emptied a group takes the
    // group's now-empty frame with it — rubber-band can't select frames, so
    // "select everything and Backspace" must not leave empty shells behind.
    if (removedCardIds.length > 0) {
      const touched = new Set<string>()
      for (const cardId of removedCardIds) {
        const card = canvasState.cards[cardId]
        const groupId = card !== undefined ? sessionWs.get(card.sessionId) : undefined
        if (groupId !== undefined) touched.add(groupId)
      }
      const framesNext = { ...wsFrames }
      let framesChanged = false
      for (const groupId of touched) {
        const remaining = (membersByGroup.get(groupId) ?? []).filter(id => !removedCardIds.includes(id))
        if (remaining.length === 0 && framesNext[groupId] !== undefined) {
          delete framesNext[groupId]
          framesChanged = true
        }
      }
      // wsColors is deliberately kept: a re-import brings the color back.
      if (framesChanged) canvas.patchGlobalNow({ wsFrames: framesNext })
    }
  }

  const onEdgesChange = (changes: EdgeChange[]): void => {
    // Removals batch into ONE store call: a hub card's Backspace emits one
    // remove per connected edge, and per-edge calls would mean one undo
    // frame, one state copy, and one POST each.
    const removedIds: string[] = []
    for (const change of changes) {
      if (change.type === 'select') {
        setSelectedEdgeIds((previous) => {
          const next = new Set(previous)
          if (change.selected) next.add(change.id)
          else next.delete(change.id)
          return next
        })
      } else if (change.type === 'remove') {
        // Lineage edges are derived — nothing to delete.
        if (!change.id.startsWith('lineage-')) removedIds.push(change.id)
        setSelectedEdgeIds((previous) => {
          const next = new Set(previous)
          next.delete(change.id)
          return next
        })
      }
    }
    if (removedIds.length > 0) canvas.removeEdges(removedIds)
  }

  // Mount guard + timer cleanup: a push settling after the map closed must
  // not set state on the unmounted component or park a timer holding the
  // render closure alive.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    }
  }, [])

  const showToast = (message: string): void => {
    if (!mountedRef.current) return
    setToast({ message })
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => { setToast(null) }, 4000)
  }

  // Messages raised outside React (the right-Sidebar file fallback) ride the
  // same bottom toast; the store drops the notice once it is on screen.
  const mapNotice = useSyncExternalStore(subscribeMapNotice, getMapNotice, () => null)
  useEffect(() => {
    if (mapNotice === null) return
    showToast(mapNotice.message)
    clearMapNotice(mapNotice.seq)
  }, [mapNotice])

  /** A toast that carries one inline action (「已归档 · 取消」). It lives longer
   *  than the plain one — the undo window is the point. */
  const showActionToast = (
    message: string,
    actionLabel: string,
    onAction: () => void,
    durationMs = 8000,
  ): void => {
    if (!mountedRef.current) return
    setToast({ message, actionLabel, onAction })
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => { setToast(null) }, durationMs)
  }

  /** Pick edge anchor sides from the cards' relative placement. */
  const sideHandles = (from: Card, to: Card): { fromHandle: string; toHandle: string } => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? { fromHandle: 'r', toHandle: 'l' } : { fromHandle: 'l', toHandle: 'r' }
    }
    return dy >= 0 ? { fromHandle: 'b', toHandle: 't' } : { fromHandle: 't', toHandle: 'b' }
  }

  /** A plain association between two existing cards. One edge per pair —
   * a second draw over an already-connected pair is silently a no-op. */
  const createLinkEdge = (
    fromCardId: string,
    toCardId: string,
    handles?: { fromHandle?: string | null; toHandle?: string | null },
  ): void => {
    if (fromCardId === toCardId) return
    const exists = Object.values(canvasState.edges).some(edge =>
      (edge.fromCardId === fromCardId && edge.toCardId === toCardId)
      || (edge.fromCardId === toCardId && edge.toCardId === fromCardId))
    if (exists) return
    const fromCard = canvasState.cards[fromCardId]
    const toCard = canvasState.cards[toCardId]
    if (fromCard === undefined || toCard === undefined) return
    const geometry = sideHandles(fromCard, toCard)
    const fromTitle = sessions.byId[fromCard.sessionId]?.displayTitle
    canvas.addEdges({
      [`edge-${crypto.randomUUID()}`]: {
        boardId: INBOX_BOARD_ID,
        fromCardId,
        toCardId,
        injection: { kind: 'link' },
        fromHandle: handles?.fromHandle ?? geometry.fromHandle,
        toHandle: handles?.toHandle ?? geometry.toHandle,
        ...(fromTitle !== undefined ? { fromTitle } : {}),
        createdAt: Date.now(),
      },
    })
  }

  /** Handle-to-handle drop on another card (ConnectionMode.Loose). */
  const onConnect = (connection: Connection): void => {
    // An Esc-cancelled gesture must not create an edge even when released
    // on a handle (React Flow calls onConnect BEFORE onConnectEnd; the
    // flag is reset there).
    if (connectCancelledRef.current) return
    createLinkEdge(connection.source, connection.target, {
      fromHandle: connection.sourceHandle,
      toHandle: connection.targetHandle,
    })
  }

  /** The pipe: push the source's latest digest into the target's inbox. */
  const pushAlongEdge = async (fromCardId: string, toCardId: string): Promise<void> => {
    const fromCard = canvasState.cards[fromCardId]
    const toCard = canvasState.cards[toCardId]
    if (fromCard === undefined || toCard === undefined) return
    const digest = canvasState.digests[fromCard.sessionId]
    if (digest === undefined || digestIsEmpty(digest)) return
    const fromTitle = sessions.byId[fromCard.sessionId]?.displayTitle ?? fromCard.sessionId
    const toTitle = sessions.byId[toCard.sessionId]?.displayTitle ?? toCard.sessionId
    try {
      await talkMapApi.injectContext(toCard.sessionId, [
        { sessionId: fromCard.sessionId, text: buildPushText(fromTitle, digest) },
      ])
      showToast(t('toast.pushed', { to: toTitle }))
    } catch (error) {
      const code = (error as ApiError).code
      showToast(code === 'session-not-live'
        ? t('toast.notLive')
        : `${t('toast.pushFailed')}${String(error)}`)
    }
  }

  const onConnectEnd = (
    event: MouseEvent | TouchEvent,
    connectionState: FinalConnectionState,
  ): void => {
    setConnecting(false)
    if (connectCancelledRef.current) {
      connectCancelledRef.current = false
      return
    }
    if (connectionState.isValid === true) return // landed on a handle → onConnect
    const fromNodeId = connectionState.fromNode?.id
    if (fromNodeId === undefined) return
    const card = canvasState.cards[fromNodeId]
    if (card === undefined) return
    const client = 'clientX' in event
      ? { x: event.clientX, y: event.clientY }
      : event.changedTouches[0] !== undefined
        ? { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY }
        : undefined
    if (client === undefined) return
    const position = screenToFlowPosition(client)
    // Dropped on an existing card's BODY (between handles)? That's a link,
    // not a fork — only a drop on empty canvas opens the spawn panel.
    // DOM hit-testing, not card-rect math: cards are min-height and grow
    // with their digest, so a fixed-height rectangle misjudges both the
    // lower band of tall cards and the space under short ones — and the
    // DOM answers with proper stacking order for overlapping cards.
    // elementsFromPoint (plural): overlay UI (the Controls panel, the
    // color toolbar) floats above the canvas and would shadow a card
    // beneath it — walk the whole stack for the topmost card node.
    const hitNode = document.elementsFromPoint(client.x, client.y)
      .map(el => el.closest('.react-flow__node[data-id^="card-"]'))
      .find(el => el !== null)
    const hitId = hitNode?.getAttribute('data-id') ?? undefined
    if (hitId !== undefined && visibleCards[hitId] !== undefined) {
      if (hitId !== fromNodeId) createLinkEdge(fromNodeId, hitId)
      return
    }
    const summary = sessions.byId[card.sessionId]
    if (summary === undefined) return
    const parentWorkspaceId = sessionWs.get(card.sessionId)
    // The fork box appears exactly where the connection was dropped — the
    // same in-place draft the right-click "new conversation" opens, but
    // carrying the source's summary and the three inheritance modes.
    openDraftAt(position.x, position.y, {
      cardId: fromNodeId,
      sessionId: card.sessionId,
      title: summary.displayTitle,
      ...(parentWorkspaceId !== undefined ? { workspaceId: parentWorkspaceId } : {}),
    }, true)
  }

  const openSession = (sessionId: string): void => {
    const services = getServices()
    if (services === undefined) return
    if (props.onOpenSession !== undefined) {
      props.onOpenSession(sessionId)
      return
    }
    mapUi.setOpen(false)
    openSessionInMain(sessionId)
  }

  const groupAtPoint = (x: number, y: number): string | undefined => {
    for (const [groupId, rect] of Object.entries(wsFrames)) {
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return groupId
    }
    return undefined
  }

  const openDraftAt = (flowX: number, flowY: number, parent?: DraftParent, alignLeft = false): void => {
    // Dropping a connection pins the box's LEFT edge on the drop point; the
    // click/shortcut paths keep centering on the click.
    const x = alignLeft ? flowX : snap(flowX - CARD_W / 2)
    const y = snap(flowY - 40)
    const groupId = groupAtPoint(flowX, flowY)
    const isWorkspace = groupId !== undefined && wsTitles.has(groupId)
    setDraft({
      x,
      y,
      ...(parent !== undefined ? { parent } : {}),
      ...(parent?.workspaceId !== undefined
        ? { workspaceId: parent.workspaceId }
        : isWorkspace ? { workspaceId: groupId } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
    })
  }

  /**
   * The instant path: a plain double-click on empty canvas — or 新对话 in the
   * right-click menu — creates the conversation outright instead of opening
   * the draft form. Everything uses deployment defaults: the workspace frame
   * the click landed in, else the default workspace; the plain 'standard'
   * preset when the deployment ships it; the deployment's default model.
   *
   * The card placement is recorded at the click point, and the conversation
   * opens in the drawer right away. The card itself stays invisible until the
   * first message lands — an empty log is not drawn on the board — then it
   * appears exactly where the click was.
   */
  const creatingChatRef = useRef(false)
  const createConversationAt = async (flowX: number, flowY: number): Promise<void> => {
    // Two fast double-clicks must not race into two conversations.
    if (creatingChatRef.current) return
    const services = getServices()
    if (services === undefined) {
      showToast(t('draft.createNotReady'))
      return
    }
    const remote = services.remote
    const createSession = services.sessions.create
    if (remote === undefined || createSession === undefined) {
      showToast(t('draft.createNotReady'))
      return
    }
    const frameId = groupAtPoint(flowX, flowY)
    const targetWorkspaceId = newConversationWorkspace({
      ...(frameId !== undefined && wsTitles.has(frameId) ? { frameWorkspaceId: frameId } : {}),
      options: draftWorkspaceOptions,
    })
    if (targetWorkspaceId === undefined) {
      showToast(t('draft.createNoWorkspace'))
      return
    }
    creatingChatRef.current = true
    try {
      const presetId = await preferredAgentPreset()
      const created = await createSession.call(services.sessions, {
        workspaceId: targetWorkspaceId,
        ...(presetId !== undefined ? { agentPreset: presetId } : {}),
      })
      const sessionId = sessionIdOf(unwrapRemote(created, 'session.create'))
      if (sessionId === undefined) throw new Error('session.create returned no session id')
      const position = newChatCardPosition(flowX, flowY)
      addSessionCard(sessionId, position.x, position.y, targetWorkspaceId)
      ensureWorkspaceFrame(targetWorkspaceId, draftWorkspaceOptions, position.x, position.y)
      if (props.onOpenChat !== undefined) {
        props.onOpenChat(sessionId)
      } else {
        mapUi.setOpen(false)
        openSessionInMain(sessionId)
      }
    } catch (error) {
      showToast(`${t('draft.createFailed')}${errorText(error)}`)
    } finally {
      creatingChatRef.current = false
    }
  }

  // ---- import actions -------------------------------------------------

  const boardSessionIds = useMemo(
    () => new Set(Object.values(canvasState.cards).map(card => card.sessionId)),
    [canvasState.cards],
  )

  const importWorkspace = (workspaceId: string, atX: number, atY: number): void => {
    const memberSessions = placeableSessionIds(sessions)
      .filter(id => sessionWs.get(id) === workspaceId && !boardSessionIds.has(id))
      .sort((a, b) => (sessions.byId[b]?.updatedAt ?? 0) - (sessions.byId[a]?.updatedAt ?? 0))
    const memory = canvasState.global?.layoutMemory ?? {}
    const remembered = memberSessions.filter(id => memory[id] !== undefined)
    const fresh = memberSessions.filter(id => memory[id] === undefined)
    const added: Record<string, Card> = {}
    const placed: Card[] = []
    // Sessions seen before return to their remembered spot (and color).
    for (const sessionId of remembered) {
      const entry = memory[sessionId]
      if (entry === undefined) continue
      const card: Card = {
        boardId: INBOX_BOARD_ID,
        sessionId,
        x: entry.x,
        y: entry.y,
        ...(entry.colorTag !== undefined ? { colorTag: entry.colorTag } : {}),
        createdAt: Date.now(),
      }
      added[newCardId()] = card
      placed.push(card)
    }
    // New sessions grid below the restored arrangement, or at the click point.
    const origin = placed.length > 0
      ? { x: snap(Math.min(...placed.map(card => card.x))), y: snap(Math.max(...placed.map(card => card.y)) + CARD_H + GAP_Y) }
      : { x: snap(atX), y: snap(atY) }
    fresh.forEach((sessionId, index) => {
      const position = gridPosition(origin, index)
      const card: Card = {
        boardId: INBOX_BOARD_ID,
        sessionId,
        x: position.x,
        y: position.y,
        createdAt: Date.now(),
      }
      added[newCardId()] = card
      placed.push(card)
    })
    if (placed.length > 0) canvas.addCards(added)
    if (workspaceId === defaultWorkspaceId) return
    const rect = placed.length > 0
      ? fitRect(placed)
      : { x: snap(atX) - FRAME_PAD, y: snap(atY) - FRAME_PAD - FRAME_LABEL_H, width: 400, height: 260 }
    canvas.setWsFrameRect(workspaceId, rect)
  }

  const importSession = (sessionId: string, atX: number, atY: number): void => {
    canvas.addCards({
      [newCardId()]: {
        boardId: INBOX_BOARD_ID,
        sessionId,
        x: snap(atX),
        y: snap(atY),
        createdAt: Date.now(),
      },
    })
  }

  const syncGroup = (groupId: string): void => {
    const rect = frameGeometry[groupId]
    if (rect === undefined) return
    const fresh = placeableSessionIds(sessions)
      .filter(id => sessionWs.get(id) === groupId && !boardSessionIds.has(id))
    if (fresh.length === 0) return
    const members = (membersByGroup.get(groupId) ?? [])
      .map(id => canvasState.cards[id])
      .filter((card): card is Card => card !== undefined)
    const origin = members.length > 0
      ? { x: Math.min(...members.map(card => card.x)), y: Math.max(...members.map(card => card.y)) + CARD_H + GAP_Y }
      : { x: rect.x + FRAME_PAD, y: rect.y + FRAME_LABEL_H + FRAME_PAD }
    const memory = canvasState.global?.layoutMemory ?? {}
    const added: Record<string, Card> = {}
    let gridIndex = 0
    for (const sessionId of fresh) {
      const entry = memory[sessionId]
      const position = entry !== undefined ? { x: entry.x, y: entry.y } : gridPosition(origin, gridIndex++)
      added[newCardId()] = {
        boardId: INBOX_BOARD_ID,
        sessionId,
        x: position.x,
        y: position.y,
        ...(entry?.colorTag !== undefined ? { colorTag: entry.colorTag } : {}),
        createdAt: Date.now(),
      }
    }
    canvas.addCards(added)
  }

  const removeGroup = (groupId: string): void => {
    for (const cardId of membersByGroup.get(groupId) ?? []) canvas.removeCard(cardId)
    const framesNext = { ...wsFrames }
    delete framesNext[groupId]
    // wsColors is deliberately kept: a re-import brings the color back.
    canvas.patchGlobalNow({ wsFrames: framesNext })
  }
  removeGroupRef.current = removeGroup

  // ---- archive / undo --------------------------------------------------

  /** Right-click → 「归档」: archive the Session through the host, take the card
   *  off the board, and offer an 8 s undo that puts both back. Edges are
   *  snapshotted because the host deletes a removed card's edges. */
  const archiveCard = (cardId: string): void => {
    const card = canvasState.cards[cardId]
    if (card === undefined) return
    const sessionId = card.sessionId
    void (async () => {
      try {
        await talkMapApi.archiveSession(sessionId)
      } catch (error) {
        if (mountedRef.current) showToast(`${t('toast.archiveFailed')}${errorText(error)}`)
        return
      }
      if (!mountedRef.current) return
      // The archive bridge above removes the card and keeps the placement;
      // the undo only has to unarchive.
      showActionToast(t('toast.archived'), t('toast.undo'), () => {
        void (async () => {
          try {
            await talkMapApi.unarchiveSession(sessionId)
            if (mountedRef.current) showToast(t('toast.unarchived'))
          } catch (error) {
            if (mountedRef.current) showToast(`${t('toast.unarchiveFailed')}${errorText(error)}`)
          }
        })()
      })
    })()
  }

  // ---- context menu ----------------------------------------------------

  const menuState: MenuState | null = useMemo(() => {
    if (menu === null) return null
    const close = (): void => { setMenu(null) }
    const items: MenuItem[] = []
    let title: string | undefined

    if (menu.view === 'new-ws') {
      const parentDir = ((): string => {
        const sample = workspaces.items[0]?.path
        if (sample === undefined) return ''
        const cut = sample.lastIndexOf('/')
        return cut > 0 ? sample.slice(0, cut) : sample
      })()
      return {
        left: menu.left,
        top: menu.top,
        title: t('menu.newWs'),
        prompt: {
          placeholder: t('draft.wsNamePlaceholder'),
          submitLabel: t('menu.createAndImport'),
          preview: (value: string) => `${parentDir}/${value}`,
          onSubmit: async (value: string) => {
            const services = getServices()
            const remote = services?.remote
            if (services === undefined || remote === undefined || parentDir === '') {
              throw new Error('dsh connection is not ready')
            }
            const path = `${parentDir}/${value}`
            await talkMapApi.ensureDir(path)
            const created = unwrapRemote<{ workspace: { workspaceId: string } }>(
              await remote.workspace.create({ path }),
              'workspace.create',
            )
            importWorkspace(created.workspace.workspaceId, menu.flowX, menu.flowY)
            close()
          },
        },
        items: [],
      }
    }

    if (menu.view === 'import-ws') {
      title = t('menu.importWs')
      items.push({
        key: '__new__',
        label: t('menu.newWs'),
        onPick: () => { setMenu({ ...menu, view: 'new-ws' }) },
      })
      for (const item of workspaces.items) {
        const imported = wsFrames[item.workspaceId] !== undefined
        items.push({
          key: item.workspaceId,
          label: item.title,
          ...(imported ? { hint: t('menu.alreadyImported') } : {}),
          onPick: () => {
            if (imported) syncGroup(item.workspaceId)
            else importWorkspace(item.workspaceId, menu.flowX, menu.flowY)
            close()
          },
        })
      }
    } else if (menu.view === 'import-session') {
      title = t('menu.importSession')
      const candidates = placeableSessionIds(sessions)
        .filter(id => !boardSessionIds.has(id))
        .slice(0, 200)
      for (const sessionId of candidates) {
        items.push({
          key: sessionId,
          label: sessions.byId[sessionId]?.displayTitle ?? sessionId,
          onPick: () => {
            importSession(sessionId, menu.flowX, menu.flowY)
            close()
          },
        })
      }
    } else if (menu.kind === 'pane') {
      items.push({
        key: 'draft',
        label: t('menu.newChat'),
        onPick: () => {
          close()
          void createConversationAt(menu.flowX, menu.flowY)
        },
      })
      items.push({
        key: 'draft-form',
        label: t('menu.newChatDraft'),
        onPick: () => {
          openDraftAt(menu.flowX, menu.flowY)
          close()
        },
      })
      items.push({
        key: 'new-ws',
        label: t('menu.newWs'),
        onPick: () => { setMenu({ ...menu, view: 'new-ws' }) },
      })
      items.push({
        key: 'import-ws',
        label: `${t('menu.importWs')}…`,
        onPick: () => { setMenu({ ...menu, view: 'import-ws' }) },
      })
      items.push({
        key: 'import-session',
        label: `${t('menu.importSession')}…`,
        onPick: () => { setMenu({ ...menu, view: 'import-session' }) },
      })
    } else if (menu.kind === 'card' && menu.targetId !== undefined) {
      const cardId = menu.targetId
      const card = canvasState.cards[cardId]
      items.push({
        key: 'open',
        label: t('menu.open'),
        onPick: () => {
          close()
          if (card !== undefined) openSession(card.sessionId)
        },
      })
      // Discoverable alternative to dragging from a tiny connection dot:
      // opens the same fork panel with the newborn card placed to the right.
      if (card !== undefined && sessions.byId[card.sessionId] !== undefined) {
        const summary = sessions.byId[card.sessionId]
        if (summary !== undefined) {
          items.push({
            key: 'fork-chat',
            label: t('menu.forkChat'),
            onPick: () => {
              close()
              const parentWorkspaceId = sessionWs.get(card.sessionId)
              openDraftAt(card.x + CARD_W + GAP_X + CARD_W / 2, card.y + CARD_H / 2 + 40, {
                cardId,
                sessionId: card.sessionId,
                title: summary.displayTitle,
                ...(parentWorkspaceId !== undefined ? { workspaceId: parentWorkspaceId } : {}),
              })
            },
          })
        }
      }
      if (card !== undefined) {
        items.push({
          key: 'archive',
          label: t('menu.archive'),
          onPick: () => {
            close()
            archiveCard(cardId)
          },
        })
      }
      items.push({
        key: 'remove',
        label: t('menu.removeCard'),
        onPick: () => {
          canvas.removeCard(cardId)
          close()
        },
      })
    } else if (menu.kind === 'edge' && menu.targetId !== undefined
      && menu.edgeFrom !== undefined && menu.edgeTo !== undefined) {
      const edgeId = menu.targetId
      const edgeFrom = menu.edgeFrom
      const edgeTo = menu.edgeTo
      const stored = canvasState.edges[edgeId]
      const fromCard = canvasState.cards[edgeFrom]
      const toCard = canvasState.cards[edgeTo]
      const fromTitle = fromCard !== undefined
        ? sessions.byId[fromCard.sessionId]?.displayTitle ?? fromCard.sessionId
        : '?'
      const toTitle = toCard !== undefined
        ? sessions.byId[toCard.sessionId]?.displayTitle ?? toCard.sessionId
        : '?'
      title = `${fromTitle} → ${toTitle}`
      const digest = fromCard !== undefined ? canvasState.digests[fromCard.sessionId] : undefined
      const noDigest = digest === undefined || digestIsEmpty(digest)
      items.push({
        key: 'push',
        label: t('edge.push'),
        ...(noDigest ? { hint: t('edge.pushNoDigest'), disabled: true } : {}),
        onPick: () => {
          close()
          void pushAlongEdge(edgeFrom, edgeTo)
        },
      })
      // Stored edges only — lineage lines are derived, nothing to persist on.
      // (Auto-sync is shelved: schema + host fan-out exist but stay
      // unwired until the feature is wanted — see the handover doc.)
      if (stored !== undefined) {
        items.push({
          key: 'delete-edge',
          label: t('edge.delete'),
          onPick: () => {
            canvas.removeEdges([edgeId])
            close()
          },
        })
      }
    } else if (menu.kind === 'frame' && menu.targetId !== undefined) {
      const groupId = menu.targetId
      items.push({
        key: 'sync',
        label: t('menu.syncGroup'),
        onPick: () => {
          syncGroup(groupId)
          close()
        },
      })
      items.push({
        key: 'remove-group',
        label: t('menu.removeGroup'),
        onPick: () => {
          removeGroup(groupId)
          close()
        },
      })
    }
    const searchable = menu.view === 'import-ws' || menu.view === 'import-session'
    return {
      left: menu.left,
      top: menu.top,
      ...(title !== undefined ? { title } : {}),
      ...(searchable ? { searchable } : {}),
      items,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, workspaces, workspaces.items, sessions, boardSessionIds, wsFrames, wsTitles, canvasState.cards, canvasState.edges, canvasState.digests, sessionWs, locale])

  const savedCamera = canvas.savedCamera(INBOX_BOARD_ID)
  const hasContent = Object.keys(visibleCards).length > 0 || Object.keys(wsFrames).length > 0

  const imageNaturalSize = (src: string): Promise<{ width: number; height: number }> => new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || 480, height: image.naturalHeight || 360 })
    image.onerror = () => resolve({ width: 480, height: 360 })
    image.src = src
  })

  const addImageFromDrop = async (payload: { src: string; title?: string }, clientX: number, clientY: number): Promise<void> => {
    const position = screenToFlowPosition({ x: clientX, y: clientY })
    try {
      const response = await fetch(payload.src)
      if (!response.ok) throw new Error(`fetch ${response.status}`)
      const blob = await response.blob()
      if (!blob.type.startsWith('image/')) throw new Error(blob.type === '' ? 'not an image' : blob.type)
      const uploaded = await talkMapApi.uploadImage(blob)
      const size = await imageNaturalSize(uploaded.src)
      const width = Math.round(Math.min(size.width, 480) || 480)
      const height = Math.round((size.height * width) / (size.width || width))
      canvas.addImages({
        [`image-${crypto.randomUUID()}`]: {
          boardId: canvasState.global?.activeBoard ?? INBOX_BOARD_ID,
          src: uploaded.src,
          ...(payload.title !== undefined && payload.title.trim() !== '' ? { title: payload.title.trim() } : {}),
          x: Math.round(position.x - width / 2),
          y: Math.round(position.y - 24),
          width,
          height,
          createdAt: Date.now(),
        },
      })
    } catch (error) {
      showToast(`${t('image.failed')}${errorText(error)}`)
    }
  }

  const onImageDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const raw = event.dataTransfer.getData('application/x-talk-map-image')
    if (raw === '') return
    event.preventDefault()
    try {
      const payload = JSON.parse(raw) as { src?: unknown; title?: unknown }
      if (typeof payload.src !== 'string' || payload.src === '') return
      void addImageFromDrop(
        { src: payload.src, ...(typeof payload.title === 'string' ? { title: payload.title } : {}) },
        event.clientX,
        event.clientY,
      )
    } catch { /* malformed drag payload */ }
  }

  const onImageDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('application/x-talk-map-image')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  return (
    <div
      ref={wrapperRef}
      className={`${styles['canvas']}${connecting ? ` ${styles['canvasConnecting']}` : ''}`}
      data-talk-map-canvas=""
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement
        // The node's own double-click handler already ran for a real node
        // target; nothing else to do.
        if (target.closest('.react-flow__node') !== null) return
        // Fast double-clicks race the first click's re-render: the second
        // click can land on the pane while the card under it is momentarily
        // unhittable. Judging by the point (not the event target) keeps that
        // gesture a card double-click instead of spawning a draft card.
        const hitCardId = cardAtClientPoint(event.clientX, event.clientY)
        if (hitCardId !== undefined) {
          const card = canvasState.cards[hitCardId]
          if (card !== undefined) {
            cancelChatSoon()
            openSession(card.sessionId)
            return
          }
        }
        if (target.closest('.react-flow__pane') === null) return
        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
        // Plain double-click creates the conversation straight away; Shift
        // keeps the old composer (workspace / model / first message /
        // attachments) for when the defaults are not what the user wants.
        if (event.shiftKey) openDraftAt(position.x, position.y)
        else void createConversationAt(position.x, position.y)
      }}
      onDragOver={onImageDragOver}
      onDrop={onImageDrop}
      onContextMenu={handleContextMenu}
      onClick={() => {
        if (menu !== null) setMenu(null)
        interactionMenu.close()
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => {
          // A fresh drag always starts clean — a cancel flag left over from
          // a path that never reached onConnectEnd must not eat this one.
          connectCancelledRef.current = false
          setConnecting(true)
        }}
        onConnectEnd={onConnectEnd}
        connectionMode={ConnectionMode.Loose}
        onSelectionStart={onSelectionStart}
        onSelectionEnd={onSelectionEnd}
        onNodeClick={(event, node) => {
          // Click a card: open its conversation in the right-hand drawer.
          // Deferred by the double-click window so a double-click keeps its
          // original "open the Session full screen" meaning (and never turns
          // into the pane double-click that spawns a draft card).
          if (node.type === 'sessionCard' && !(node as SessionCardNodeType).data.ghost) {
            cancelChatSoon()
            if (event.detail <= 1) openChatSoon((node as SessionCardNodeType).data.sessionId)
            return
          }
          if (node.type !== 'wsFrame') return
          // Click-only frame selection (React Flow never selects frames).
          const frameId = node.id
          setSelectedIds((previous) => {
            if (event.shiftKey) {
              const next = new Set(previous)
              if (next.has(frameId)) next.delete(frameId)
              else next.add(frameId)
              return next
            }
            return new Set([frameId])
          })
        }}
        onNodeDoubleClick={(_event, node) => {
          if (node.type === 'sessionCard' && !(node as SessionCardNodeType).data.ghost) {
            cancelChatSoon()
            openSession((node as SessionCardNodeType).data.sessionId)
          }
        }}
        onMoveEnd={(_event, viewport: Viewport) => {
          canvas.setCamera(INBOX_BOARD_ID, viewport)
        }}
        colorMode={dark ? 'dark' : 'light'}
        snapToGrid
        snapGrid={[GRID, GRID]}
        // A trackpad's few-pixel drift must not swallow the card click:
        // React Flow's default (0) means ANY travel between press and release
        // withholds the node's click event — the "click does nothing until you
        // click again" report. The drag still starts at 1px (nodeDragThreshold).
        nodeClickDistance={POINTER_CLICK_SLOP}
        zoomOnDoubleClick={false}
        panOnDrag={[1, 2]}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        {...(savedCamera !== undefined ? { defaultViewport: savedCamera } : { fitView: hasContent })}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID} size={1} />
        <Controls showInteractive={false}>
          <ControlButton title={t('map.zoom100')} onClick={() => { void zoomTo(1, { duration: 200 }) }}>
            <span className={styles['zoomResetLabel']}>1:1</span>
          </ControlButton>
        </Controls>
      </ReactFlow>
      {liveSelectedIds.size > 0
        ? (
            <ColorToolbar
              selectedIds={liveSelectedIds}
              visibleCards={visibleCards}
            />
          )
        : null}
      {hasContent || draft !== null ? null : <div className={styles['emptyHint']}>{t('map.empty')}</div>}
      {menuState !== null
        ? <ContextMenu key={menu?.view ?? 'root'} menu={menuState} onClose={() => { setMenu(null) }} />
        : null}
      {interactionMenuState !== null
        ? (
            <InteractionMenu
              key={interactionMenuState.sessionId}
              state={interactionMenuState}
              wrapperWidth={wrapperRef.current?.clientWidth ?? 0}
              wrapperHeight={wrapperRef.current?.clientHeight ?? 0}
              onClose={() => { interactionMenu.close() }}
              onOpenChat={props.onOpenChat}
            />
          )
        : null}
      {toast !== null
        ? (
            <div
              className={`${styles['toast']}${toast.actionLabel !== undefined ? ` ${styles['toastActionable']}` : ''}`}
              role="status"
            >
              <span className={styles['toastText']}>{toast.message}</span>
              {toast.actionLabel !== undefined && toast.onAction !== undefined
                ? (
                    <button
                      type="button"
                      className={styles['toastAction']}
                      onClick={() => {
                        const run = toast.onAction
                        if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
                        setToast(null)
                        run?.()
                      }}
                    >
                      {toast.actionLabel}
                    </button>
                  )
                : null}
            </div>
          )
        : null}
    </div>
  )
}

function ColorToolbar(props: {
  selectedIds: ReadonlySet<string>
  visibleCards: Readonly<Record<string, Card>>
}): React.JSX.Element {
  const selectedCardIds = [...props.selectedIds].filter(id => props.visibleCards[id] !== undefined)
  const selectedFrameWs = [...props.selectedIds]
    .filter(id => id.startsWith('frame-'))
    .map(id => id.slice('frame-'.length))
  const applyColor = (colorTag: string | undefined): void => {
    if (selectedCardIds.length > 0) canvas.setCardsColor(selectedCardIds, colorTag)
    for (const workspaceId of selectedFrameWs) canvas.setWorkspaceColor(workspaceId, colorTag)
  }
  return (
    <div className={styles['colorToolbar']} role="toolbar" aria-label={t('color.toolbar')}>
      <span className={styles['colorToolbarLabel']}>{t('color.toolbar')}</span>
      {COLOR_TAGS.map(tag => (
        <button
          key={tag.id}
          type="button"
          className={styles['colorSwatch']}
          style={{ background: tag.swatch }}
          title={tag.id}
          aria-label={tag.id}
          onClick={() => { applyColor(tag.id) }}
        />
      ))}
      <button
        type="button"
        className={`${styles['colorSwatch']} ${styles['colorSwatchClear']}`}
        title={t('color.clear')}
        aria-label={t('color.clear')}
        onClick={() => { applyColor(undefined) }}
      >
        ×
      </button>
    </div>
  )
}

export function MapCanvas(props: MapCanvasProps): React.JSX.Element {
  // Only the phase gates this wrapper. Subscribing to the whole store here
  // re-rendered the wrapper (and CanvasInner) on every card/pending tick.
  const phase = useSyncExternalStore(canvas.subscribe, () => canvas.get().phase)

  useEffect(() => {
    canvas.ensureLoaded()
    canvas.refresh()
    return canvas.connect()
  }, [])

  if (phase === 'error') {
    return (
      <div className={styles['canvas']}>
        <div className={styles['emptyHint']}>
          {t('map.loadError')} {canvas.get().error}
        </div>
      </div>
    )
  }
  if (phase !== 'ready') {
    return (
      <div className={styles['canvas']}>
        <div className={styles['emptyHint']}>{t('map.loading')}</div>
      </div>
    )
  }
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

export type { CanvasState }
