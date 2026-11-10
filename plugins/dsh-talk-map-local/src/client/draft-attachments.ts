/**
 * Draft-card attachment intake: the pure half of "paste or drop a file into
 * the map's new-conversation box". The component owns object URLs, React
 * state and uploads; everything here is synchronous and testable without a
 * DOM beyond the `File`/`DataTransfer` shapes the browser already gives us.
 *
 * Images are exactly the four raster types the Host accepts as prompt
 * images (`dsh-attachment`). Every other file — including SVG and HEIC —
 * travels as a generic file attachment, matching dsh's own composer.
 */

/** Raster image types the Host normalizes as prompt images. */
export type DraftImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** One browser-side attachment waiting in the draft box. */
export interface DraftAttachment {
  readonly id: string
  readonly kind: 'image' | 'file'
  readonly file: File
  /** Object URL for an image preview; absent for generic files. */
  readonly previewUrl?: string
  /** Present for images only: the media type the Host will be told. */
  readonly mediaType?: DraftImageMediaType
}

/** One image source carried by the map's own drag payload (drawer → board). */
export interface DraftImageSource {
  readonly src: string
  readonly title?: string
}

/** Result of reading one browser drop. */
export interface DropIntake {
  readonly files: File[]
  readonly imageSources: DraftImageSource[]
}

/** Prompt part this module can build without importing dsh types. */
export type DraftPromptPart =
  | { type: 'file'; receiptId: string }
  | { type: 'text'; text: string }

const IMAGE_TYPES: readonly DraftImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** The Host image type for a declared MIME value, or undefined for any other file. */
export function draftImageMediaType(value: string): DraftImageMediaType | undefined {
  return (IMAGE_TYPES as readonly string[]).includes(value)
    ? value as DraftImageMediaType
    : undefined
}

/** Whether the draft must treat this file as an image or as a verbatim file. */
export function classifyDraftFile(file: File): 'image' | 'file' {
  return draftImageMediaType(file.type) === undefined ? 'file' : 'image'
}

function fileFromItem(item: unknown): File | undefined {
  if (item === null || typeof item !== 'object') return undefined
  const candidate = item as { kind?: unknown; getAsFile?: unknown }
  if (candidate.kind !== 'file' || typeof candidate.getAsFile !== 'function') return undefined
  return (candidate.getAsFile as () => File | null)() ?? undefined
}

/**
 * Files carried by a paste. Clipboard items come first (source order), then
 * `files` entries not already seen. Text items are ignored: the textarea's
 * default paste handles text.
 */
export function collectClipboardFiles(transfer: DataTransfer | null): File[] {
  if (transfer === null) return []
  const files: File[] = []
  const seen = new Set<File>()
  for (const item of Array.from(transfer.items ?? [])) {
    const file = fileFromItem(item)
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    files.push(file)
  }
  for (const file of Array.from(transfer.files ?? [])) {
    if (seen.has(file)) continue
    seen.add(file)
    files.push(file)
  }
  return files
}

function parseImageSource(raw: string): DraftImageSource | undefined {
  if (raw === '') return undefined
  try {
    const value = JSON.parse(raw) as { src?: unknown; title?: unknown }
    if (typeof value.src !== 'string' || value.src === '') return undefined
    return {
      src: value.src,
      ...(typeof value.title === 'string' && value.title !== '' ? { title: value.title } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Read one drop. Precedence matters: the application-internal file token is
 * the original bytes of an image dragged out of the drawer, so it wins over
 * the map's URL payload (which would otherwise attach the same image twice).
 */
export function collectDropIntake(
  transfer: DataTransfer,
  readAppFile?: (transfer: DataTransfer) => File | undefined,
): DropIntake {
  const appFile = readAppFile?.(transfer)
  if (appFile !== undefined) return { files: [appFile], imageSources: [] }
  const source = parseImageSource(transfer.getData('application/x-talk-map-image'))
  if (source !== undefined) return { files: [], imageSources: [source] }
  return { files: Array.from(transfer.files ?? []), imageSources: [] }
}

/** Whether this drag carries something the draft can attach. */
export function hasAttachmentDrag(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false
  const types = Array.from(transfer.types ?? [])
  return types.includes('Files')
    || types.includes('application/x-dsh-file')
    || types.includes('application/x-talk-map-image')
}

/** The prompt content for one send: uploaded receipts first, text last. */
export function buildPromptContent(receiptIds: readonly string[], text: string): DraftPromptPart[] {
  const content: DraftPromptPart[] = receiptIds.map(receiptId => ({ type: 'file', receiptId }))
  if (text !== '') content.push({ type: 'text', text })
  return content
}

/** A draft can be sent with attachments alone. */
export function draftSendable(text: string, attachmentCount: number): boolean {
  return text.trim() !== '' || attachmentCount > 0
}

/** The three inheritance modes of a fork draft (plain drafts behave as full). */
export type DraftSendMode = 'digest' | 'full' | 'none'

/** Everything the draft's primary-action gate reads. */
export interface DraftSendState {
  readonly busy: boolean
  readonly needsNewWorkspaceName: boolean
  readonly isFork: boolean
  readonly mode: DraftSendMode
  readonly generatingSummary: boolean
  /** The digest-injection text is empty (only meaningful for fork + digest). */
  readonly summaryEmpty: boolean
  readonly text: string
  readonly attachmentCount: number
}

/**
 * Whether 发送 / 开新对话 is disabled. Fork drafts in 完整对话 mode may send an
 * empty first message: the source history is already carried, and the prompt
 * is skipped when there is neither text nor an attachment.
 */
export function draftSendDisabled(state: DraftSendState): boolean {
  if (state.busy || state.needsNewWorkspaceName) return true
  if (state.isFork && state.mode === 'digest' && (state.generatingSummary || state.summaryEmpty)) return true
  if (state.isFork && state.mode === 'full') return false
  return !draftSendable(state.text, state.attachmentCount)
}

/** Compact byte size for the generic-file card. */
export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
