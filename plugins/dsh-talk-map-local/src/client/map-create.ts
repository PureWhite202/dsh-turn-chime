/**
 * Host-side plumbing for a conversation born on the board: load the shared
 * model/preset catalog, add the newborn card, and grow the workspace frame
 * the first time a card lands in a non-default workspace.
 *
 * Imported by both surfaces that create conversations:
 *   - the draft box (DraftCard.tsx), which lets the user fill things in first;
 *   - the instant double-click path (MapCanvas.tsx), which uses the
 *     deployment defaults and opens the conversation straight away.
 */
import type { AgentPresetEntry, ModelProviderGroup } from './dsh.ts'
import { talkMapApi } from './api.ts'
import { canvas, INBOX_BOARD_ID, newCardId } from './canvas-store.ts'
import { getServices } from './map-state.ts'
import { defaultWorkspaceOption, newChatFrameRect, type WorkspaceOption } from './new-chat.ts'

export interface DraftCatalog {
  groups: ModelProviderGroup[]
  presets: readonly AgentPresetEntry[]
  defaultModel: string
  defaultPreset: string
}

let draftCatalogPromise: Promise<DraftCatalog> | null = null

/** The model catalog / agent presets / default labels are page-wide static:
 *  load them once, lazily, and reuse them for every draft box and every
 *  instant creation. Never rejects — an unreachable catalog yields defaults. */
export function loadDraftCatalog(): Promise<DraftCatalog> {
  if (draftCatalogPromise !== null) return draftCatalogPromise
  draftCatalogPromise = (async () => {
    const services = getServices()
    const remote = services?.remote
    let groups: ModelProviderGroup[] = []
    let presets: readonly AgentPresetEntry[] = []
    let defaultModel = ''
    let defaultPreset = ''
    try {
      if (remote !== undefined) {
        const catalog = await remote.session.modelCatalog().catch(() => undefined)
        if (catalog !== undefined && catalog.ok) groups = catalog.value.groups ?? []
        const list = await remote.agentPresets.list().catch(() => undefined)
        if (list !== undefined && list.ok) presets = list.value.presets
      }
      const defaults = await talkMapApi.getDefaults().catch(() => undefined)
      if (defaults !== undefined && defaults.model !== null) defaultModel = defaults.model.model
      if (defaults !== undefined && defaults.preset !== null) defaultPreset = defaults.preset
    } catch (error) {
      console.warn('[dsh-talk-map] draft catalog unavailable:', error)
    }
    return { groups, presets, defaultModel, defaultPreset }
  })()
  return draftCatalogPromise
}

/**
 * The agent preset map-born conversations prefer: the plain 'standard' mode,
 * because the deployment default may be a specialized one (e.g. cordis).
 * `undefined` when the deployment does not ship that preset — the host then
 * applies its own default.
 */
export async function preferredAgentPreset(): Promise<string | undefined> {
  const catalog = await loadDraftCatalog()
  return catalog.presets.some(preset => preset.id === 'standard') ? 'standard' : undefined
}

/**
 * Add the newborn card at exactly (x, y). Blank conversations are not drawn
 * on the board yet (an empty log is noise), but the placement is recorded, so
 * the card appears at this spot as soon as the first message lands.
 */
export function addSessionCard(sessionId: string, x: number, y: number, wsOverride?: string): string {
  const cardId = newCardId()
  canvas.addCards({
    [cardId]: {
      boardId: INBOX_BOARD_ID,
      sessionId,
      x,
      y,
      ...(wsOverride !== undefined && wsOverride !== '' ? { wsOverride } : {}),
      createdAt: Date.now(),
    },
  })
  return cardId
}

/**
 * The default workspace stays unframed; any other workspace grows a frame
 * the first time a card lands in it. An existing frame is never overwritten
 * (the user may have resized it).
 */
export function ensureWorkspaceFrame(
  workspaceId: string,
  options: readonly WorkspaceOption[],
  x: number,
  y: number,
): void {
  if (workspaceId === defaultWorkspaceOption(options)) return
  if (canvas.get().global?.wsFrames?.[workspaceId] !== undefined) return
  canvas.setWsFrameRect(workspaceId, newChatFrameRect(x, y))
}
