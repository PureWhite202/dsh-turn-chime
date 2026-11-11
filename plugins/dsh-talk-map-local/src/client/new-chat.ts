/**
 * "A new conversation born on the map": the decisions that need neither a
 * canvas nor a host, kept pure so `node --test` can pin them down.
 *
 * Two surfaces ask these questions:
 *   - the draft box (workspace / model / first message filled in by hand);
 *   - the instant double-click path, which creates the conversation with the
 *     deployment defaults and opens it — no form in between.
 * Both must land in the same workspace and at the same spot, so the rules
 * live here instead of being copied into each surface.
 */

/** One workspace the map can offer as a destination for a new conversation. */
export interface WorkspaceOption {
  id: string
  title: string
  path: string
}

/** Directory part of a path (both separators), lower-cased. */
export function workspaceDirectoryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).toLowerCase()
}

/**
 * The deployment's own `default-workspace`, matched by title or directory
 * name — the same rule the sidebar and the frame layout use. Conversations
 * born on bare canvas land there instead of silently creating yet another
 * workspace.
 */
export function defaultWorkspaceOption(options: readonly WorkspaceOption[]): string | undefined {
  const match = options.find(option =>
    option.title.trim().toLowerCase() === 'default-workspace'
    || workspaceDirectoryName(option.path) === 'default-workspace')
  return match?.id
}

/** Parent directory new workspaces land in: alongside the existing ones. */
export function newWorkspaceParent(options: readonly WorkspaceOption[]): string {
  const sample = options[0]?.path
  if (sample === undefined) return '~'
  const cut = sample.lastIndexOf('/')
  return cut > 0 ? sample.slice(0, cut) : sample
}

/**
 * Where a brand-new conversation goes: the workspace frame the click landed
 * in, else the deployment default, else the first workspace the host still
 * has. `undefined` only when the host has no workspace at all.
 */
export function newConversationWorkspace(input: {
  /** Workspace frame under the click, when the point fell inside one. */
  frameWorkspaceId?: string
  options: readonly WorkspaceOption[]
}): string | undefined {
  const insideFrame = input.frameWorkspaceId
  if (insideFrame !== undefined && insideFrame !== '') return insideFrame
  return defaultWorkspaceOption(input.options) ?? input.options[0]?.id
}

/** Grid the board snaps card positions to. */
export const NEW_CHAT_GRID = 16/** Card width the placement math centres on (the rendered card may grow). */
export const NEW_CHAT_CARD_W = 250
/** Card height the renderer assumes before it reports a real height. */
export const NEW_CHAT_CARD_H = 120

export function snapToGrid(value: number): number {
  return Math.round(value / NEW_CHAT_GRID) * NEW_CHAT_GRID
}

/**
 * Card position for a click at (flowX, flowY): horizontally centred on the
 * click, top edge slightly below it. This is the spot the draft box used to
 * occupy, so an instant creation lands exactly where the user pointed.
 */
export function newChatCardPosition(flowX: number, flowY: number): { x: number; y: number } {
  return { x: snapToGrid(flowX - NEW_CHAT_CARD_W / 2), y: snapToGrid(flowY - 40) }
}

/**
 * Starting rect for a workspace frame that is about to receive its first
 * card. Sizes match the draft box's historic frame; the board re-fits the
 * frame from the real member cards on the next render.
 */
export function newChatFrameRect(
  x: number,
  y: number,
  cardWidth: number = 224,
  cardHeight: number = NEW_CHAT_CARD_H,
): { x: number; y: number; width: number; height: number } {
  const pad = 32
  const labelHeight = 30
  return {
    x: x - pad,
    y: y - pad - labelHeight,
    width: cardWidth + pad * 2,
    height: cardHeight + pad * 2 + labelHeight,
  }
}
