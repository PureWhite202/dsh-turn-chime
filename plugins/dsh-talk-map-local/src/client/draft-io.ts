/**
 * Host-side plumbing shared by every surface that starts a conversation from
 * user input: upload the attachments a box collected, then send the opening
 * prompt. The map's draft card and the drawer's fork setup both need exactly
 * this sequence, so it lives once here instead of per surface.
 */
import type { FileUploadProgress, FileUploadReceipt, RemoteService } from './dsh.ts'
import type { DraftAttachment } from './draft-attachments.ts'
import { buildPromptContent } from './draft-attachments.ts'
import { getServices, unwrapRemote } from './map-state.ts'
import { t } from './i18n.ts'

export interface DraftUploadHooks {
  /** "Uploading 1/2…" note while bytes leave the browser. */
  onNote?: (note: string | undefined) => void
  /** Per-attachment 0..1 ratios (merged by the caller's state). */
  onProgress?: (progress: Readonly<Record<string, number>>) => void
}

/** Upload every pending attachment into `sessionId` and return the receipts. */
export async function uploadDraftAttachments(options: {
  sessionId: string
  attachments: readonly DraftAttachment[]
  signal: AbortSignal
  onNote?: DraftUploadHooks['onNote']
  onProgress?: DraftUploadHooks['onProgress']
}): Promise<string[]> {
  const services = getServices()
  if (services === undefined) throw new Error(t('draft.createNotReady'))
  const { sessionId, attachments, signal } = options
  if (attachments.length === 0) return []
  const receiptIds: string[] = []
  try {
    for (const [index, attachment] of attachments.entries()) {
      options.onNote?.(t('draft.uploading', { done: String(index + 1), total: String(attachments.length) }))
      const onProgress = (progress: FileUploadProgress): void => {
        const ratio = progress.total !== undefined && progress.total > 0
          ? Math.min(1, progress.loaded / progress.total)
          : 0
        options.onProgress?.({ [attachment.id]: ratio })
      }
      const result = attachment.kind === 'image' && attachment.mediaType !== undefined
        ? await services.fileUpload.uploadImage(
            sessionId,
            attachment.file,
            attachment.mediaType,
            attachment.file.name,
            signal,
            onProgress,
          )
        : await services.fileUpload.upload(
            sessionId,
            attachment.file,
            attachment.file.name,
            signal,
            onProgress,
          )
      const value = unwrapRemote<FileUploadReceipt>(result, 'fileUpload')
      receiptIds.push(value.receiptId)
    }
  } catch (uploadError) {
    if (signal.aborted) throw uploadError
    throw new Error(`${t('draft.uploadFailed')}${uploadError instanceof Error ? uploadError.message : String(uploadError)}`)
  } finally {
    options.onNote?.(undefined)
    options.onProgress?.({})
  }
  return receiptIds
}

/** Queue the opening prompt. Attachments alone are a valid message. */
export async function sendDraftPrompt(
  remote: RemoteService,
  sessionId: string,
  promptText: string,
  receiptIds: readonly string[],
): Promise<void> {
  const content = buildPromptContent(receiptIds, promptText)
  if (content.length === 0) return
  unwrapRemote<void>(await remote.session.prompt({
    requestId: crypto.randomUUID(),
    sessionId,
    mode: 'queue',
    content,
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }), 'session.prompt')
}
