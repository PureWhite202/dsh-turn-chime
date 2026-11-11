/**
 * The fork setup panel: the drawer body for a marker dropped by a connection
 * drag. It is the old map draft box, moved into the sidebar — inheritance
 * mode, the (editable) digest, workspace/model/preset, attachments and the
 * first message — with one difference: nothing is created until 开新对话 is
 * pressed, and the marker on the board is what becomes the card.
 */
import { useEffect, useRef, useState } from 'react'
import type { AgentPresetEntry, ModelProviderGroup, RemoteService } from './dsh.ts'
import type { ForkBox } from './fork-box.ts'
import { defaultWorkspaceOption, newWorkspaceParent, type WorkspaceOption } from './new-chat.ts'
import { canvas } from './canvas-store.ts'
import { addForkEdge, addSessionCard, ensureWorkspaceFrame, loadDraftCatalog } from './map-create.ts'
import { getServices, sessionIdOf, unwrapRemote } from './map-state.ts'
import {
  classifyDraftFile,
  collectClipboardFiles,
  collectDropIntake,
  draftImageMediaType,
  draftSendDisabled,
  formatAttachmentBytes,
  hasAttachmentDrag,
  type DraftAttachment,
  type DraftImageSource,
} from './draft-attachments.ts'
import { sendDraftPrompt, uploadDraftAttachments } from './draft-io.ts'
import { buildInjectionText, digestIsEmpty } from './digest-text.ts'
import { talkMapApi } from './api.ts'
import { t } from './i18n.ts'
import styles from './talk-map.module.css'

const NEW_WORKSPACE = '__new__'

export interface ForkSetupPanelProps {
  box: ForkBox
  workspaceOptions: readonly WorkspaceOption[]
  /** Close the panel; the marker stays on the board. */
  onClose: () => void
  /** The fork exists: the drawer should switch to its conversation. */
  onCreated: (sessionId: string, cardId: string) => void
}

export function ForkSetupPanel(props: ForkSetupPanelProps): React.JSX.Element {
  const { box, workspaceOptions } = props
  const [mode, setMode] = useState<'digest' | 'full' | 'none'>('full')
  const [generatingSummary, setGeneratingSummary] = useState(false)
  /** The digest was generated once for this panel: later switches reuse it. */
  const summaryRequestedRef = useRef(false)
  const [summary, setSummary] = useState(() => buildInjectionText(box.parentTitle, canvas.get().digests[box.parentSessionId]))
  const [workspaceId, setWorkspaceId] = useState(
    box.parentWorkspaceId ?? defaultWorkspaceOption(workspaceOptions) ?? workspaceOptions[0]?.id ?? NEW_WORKSPACE,
  )
  const workspacePicked = useRef(false)
  const [newWsName, setNewWsName] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [presetId, setPresetId] = useState('')
  const [groups, setGroups] = useState<ModelProviderGroup[]>([])
  const [presets, setPresets] = useState<readonly AgentPresetEntry[]>([])
  const [defaultModelLabel, setDefaultModelLabel] = useState('')
  const [defaultPresetLabel, setDefaultPresetLabel] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // ---- attachments (paste / drop) -------------------------------------
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [uploadNote, setUploadNote] = useState<string | undefined>(undefined)
  const [uploadProgress, setUploadProgress] = useState<Readonly<Record<string, number>>>({})
  const attachmentsRef = useRef<readonly DraftAttachment[]>([])
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])
  useEffect(() => () => {
    abortRef.current?.abort()
    abortRef.current = null
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl)
    }
    attachmentsRef.current = []
  }, [])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Workspace options can arrive after the panel mounts: adopt the default
  // then, unless the user already chose something.
  useEffect(() => {
    if (workspacePicked.current) return
    const fallback = box.parentWorkspaceId ?? defaultWorkspaceOption(workspaceOptions) ?? workspaceOptions[0]?.id
    if (fallback === undefined) return
    setWorkspaceId(previous => (previous === NEW_WORKSPACE ? fallback : previous))
  }, [box.parentWorkspaceId, workspaceOptions])

  // The model/preset selectors only exist outside 完整对话 — and the catalog
  // is page-wide static. GET the roster for the fork's own selectors.
  useEffect(() => {
    let cancelled = false
    void loadDraftCatalog().then((catalog) => {
      if (cancelled) return
      setGroups(catalog.groups)
      setPresets(catalog.presets)
      setDefaultModelLabel(catalog.defaultModel)
      setDefaultPresetLabel(catalog.defaultPreset)
      // Prefer the plain 'standard' preset for conversations born on the map.
      if (catalog.presets.some(preset => preset.id === 'standard')) {
        setPresetId(previous => (previous === '' ? 'standard' : previous))
      }
    })
    return () => { cancelled = true }
  }, [])

  const creatingWorkspace = workspaceId === NEW_WORKSPACE
  const newWsPath = `${newWorkspaceParent(workspaceOptions)}/${newWsName.trim()}`
  const showConfig = mode !== 'full'
  const needsNewWorkspaceName = showConfig && creatingWorkspace && newWsName.trim() === ''
  const sendDisabled = draftSendDisabled({
    busy,
    needsNewWorkspaceName,
    isFork: true,
    mode,
    generatingSummary,
    summaryEmpty: summary.trim() === '',
    text,
    attachmentCount: attachments.length,
  })

  const addFiles = (files: readonly File[]): void => {
    if (files.length === 0 || busy) return
    const created = files.map((file): DraftAttachment => {
      const kind = classifyDraftFile(file)
      const mediaType = kind === 'image' ? draftImageMediaType(file.type) : undefined
      return {
        id: crypto.randomUUID(),
        kind,
        file,
        ...(kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
        ...(mediaType !== undefined ? { mediaType } : {}),
      }
    })
    setAttachments(previous => [...previous, ...created])
    setError(undefined)
  }

  const removeAttachment = (id: string): void => {
    if (busy) return
    const target = attachments.find(attachment => attachment.id === id)
    if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl)
    setAttachments(previous => previous.filter(attachment => attachment.id !== id))
  }

  /** A dragged map image is a URL, not a File: fetch its bytes first. */
  const addImageSource = async (source: DraftImageSource): Promise<void> => {
    try {
      const response = await fetch(source.src)
      if (!response.ok) throw new Error(`fetch ${response.status}`)
      const blob = await response.blob()
      const fromUrl = source.src.split('/').pop() ?? ''
      const name = source.title !== undefined && source.title.trim() !== ''
        ? source.title.trim()
        : (fromUrl === '' ? 'image' : decodeURIComponent(fromUrl))
      addFiles([new File([blob], name, { type: blob.type })])
    } catch (attachError) {
      setError(`${t('draft.attachFailed')}${String(attachError)}`)
    }
  }

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (busy) return
    const files = collectClipboardFiles(event.clipboardData)
    if (files.length === 0) return
    if (event.clipboardData?.getData('text/plain') === '') event.preventDefault()
    addFiles(files)
  }

  const onAttachmentDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (busy || !hasAttachmentDrag(event.dataTransfer)) return
    event.preventDefault()
    setDragActive(true)
  }

  const onAttachmentDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasAttachmentDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    if (!busy) setDragActive(true)
  }

  const onAttachmentDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Element | null)) return
    setDragActive(false)
  }

  const onAttachmentDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasAttachmentDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setDragActive(false)
    if (busy) return
    const services = getServices()
    const readAppFile = services !== undefined && services.fileDrag !== undefined
      ? (transfer: DataTransfer): File | undefined => services.fileDrag.read(transfer)
      : undefined
    const intake = collectDropIntake(event.dataTransfer, readAppFile)
    addFiles(intake.files)
    for (const source of intake.imageSources) void addImageSource(source)
  }

  /** Choosing 摘要注入 asks the model for a fresh digest of the source card. */
  const generateSummary = async (): Promise<void> => {
    if (generatingSummary) return
    setGeneratingSummary(true)
    setError(undefined)
    try {
      const result = await talkMapApi.refreshDigest(box.parentSessionId)
      setSummary(buildInjectionText(box.parentTitle, result.digest))
      summaryRequestedRef.current = true
    } catch (generateError) {
      setError(String(generateError))
    } finally {
      setGeneratingSummary(false)
    }
  }

  /** Resolve the destination workspace, creating the folder/workspace on demand. */
  const resolveTargetWorkspace = async (remote: RemoteService): Promise<string> => {
    if (workspaceId !== NEW_WORKSPACE) return workspaceId
    await talkMapApi.ensureDir(newWsPath)
    const created = unwrapRemote<{ workspace: { workspaceId: string } }>(
      await remote.workspace.create({ path: newWsPath }),
      'workspace.create',
    )
    return created.workspace.workspaceId
  }

  const create = async (): Promise<void> => {
    const services = getServices()
    if (services === undefined || sendDisabled) return
    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal
    setBusy(true)
    setError(undefined)
    try {
      const remote = services.remote
      const createSession = services.sessions.create
      if (remote === undefined || createSession === undefined) throw new Error(t('draft.createNotReady'))

      if (mode === 'full') {
        // dsh-native fork: the child carries the source's full history.
        const forked = unwrapRemote(await services.sessions.fork({ sessionId: box.parentSessionId }), 'session.fork')
        const childId = sessionIdOf(forked)
        if (childId === undefined) throw new Error('session.fork returned no session id')
        const receiptIds = await uploadDraftAttachments({
          sessionId: childId,
          attachments,
          signal,
          onNote: setUploadNote,
          onProgress: (progress) => setUploadProgress(previous => ({ ...previous, ...progress })),
        })
        if (signal.aborted) return
        const cardId = addSessionCard(childId, box.x, box.y, box.parentWorkspaceId)
        addForkEdge({
          parentCardId: box.parentCardId,
          toCardId: cardId,
          kind: 'full',
          ...(box.fromHandle !== undefined ? { fromHandle: box.fromHandle } : {}),
        })
        if (box.parentWorkspaceId !== undefined) {
          ensureWorkspaceFrame(box.parentWorkspaceId, workspaceOptions, box.x, box.y)
        }
        if (signal.aborted) return
        await sendDraftPrompt(remote, childId, text, receiptIds)
        if (signal.aborted) return
        props.onCreated(childId, cardId)
        return
      }

      const targetWorkspaceId = await resolveTargetWorkspace(remote)
      const created = await createSession.call(services.sessions, {
        workspaceId: targetWorkspaceId,
        ...(presetId !== '' ? { agentPreset: presetId } : {}),
      })
      const sessionId = sessionIdOf(unwrapRemote(created, 'session.create'))
      if (sessionId === undefined) throw new Error('session.create returned no session id')
      const receiptIds = await uploadDraftAttachments({
        sessionId,
        attachments,
        signal,
        onNote: setUploadNote,
        onProgress: (progress) => setUploadProgress(previous => ({ ...previous, ...progress })),
      })
      if (signal.aborted) return
      if (mode === 'digest') {
        // Background first, then the user's opening message.
        await talkMapApi.injectContext(sessionId, [{ sessionId: box.parentSessionId, text: summary }])
        if (signal.aborted) return
      }
      const cardId = addSessionCard(sessionId, box.x, box.y, targetWorkspaceId)
      addForkEdge({
        parentCardId: box.parentCardId,
        toCardId: cardId,
        kind: mode === 'digest' ? 'digest' : 'none',
        ...(mode === 'digest' ? { injectedText: summary } : {}),
        ...(box.fromHandle !== undefined ? { fromHandle: box.fromHandle } : {}),
      })
      ensureWorkspaceFrame(targetWorkspaceId, workspaceOptions, box.x, box.y)
      if (modelKey !== '') {
        const [provider, model] = modelKey.split('::') as [string, string]
        unwrapRemote<void>(await remote.session.selectModel({ sessionId, provider, model }), 'session.selectModel')
      }
      if (signal.aborted) return
      await sendDraftPrompt(remote, sessionId, text, receiptIds)
      if (signal.aborted) return
      props.onCreated(sessionId, cardId)
    } catch (failure) {
      if (controller.signal.aborted) return
      setError(failure instanceof Error && failure.message !== '' ? failure.message : String(failure))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setBusy(false)
      setUploadNote(undefined)
    }
  }

  const forkModes: { id: 'digest' | 'full' | 'none'; label: string }[] = [
    { id: 'full', label: t('spawn.mode.full') },
    { id: 'digest', label: t('spawn.mode.digest') },
    { id: 'none', label: t('spawn.mode.none') },
  ]

  return (
    <div
      className={`${styles['forkPanel']}${dragActive ? ` ${styles['forkPanelDrop']}` : ''}`}
      onDragEnter={onAttachmentDragEnter}
      onDragOver={onAttachmentDragOver}
      onDragLeave={onAttachmentDragLeave}
      onDrop={onAttachmentDrop}
    >
      <div className={styles['spawnFrom']}>{t('fork.from', { name: box.parentTitle })}</div>
      <div className={styles['spawnModes']}>
        {forkModes.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`${styles['spawnModeBtn']}${mode === entry.id ? ` ${styles['spawnModeActive']}` : ''}`}
            onClick={() => {
              // Generate the digest only the first time this panel switches to
              // 摘要注入; later clicks reuse it and never hit the model.
              if (entry.id === 'digest' && !summaryRequestedRef.current) void generateSummary()
              setMode(entry.id)
            }}
            disabled={busy}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {mode === 'digest'
        ? generatingSummary
          ? <div className={styles['spawnHint']}>{t('spawn.generating')}</div>
          : (
            <>
              <div className={styles['spawnHint']}>{t('spawn.hint')}</div>
              <textarea
                className={styles['spawnTextarea']}
                value={summary}
                rows={6}
                onChange={(event) => { setSummary(event.target.value) }}
                disabled={busy}
              />
              {digestIsEmpty(canvas.get().digests[box.parentSessionId])
                ? <div className={styles['spawnHint']}>{t('spawn.noDigest')}</div>
                : null}
            </>
          )
        : mode === 'none'
          ? <div className={styles['spawnHint']}>{t('spawn.noneHint')}</div>
          : <div className={styles['spawnHint']}>{t('spawn.fullHint')}</div>}
      {showConfig
        ? (
            <>
              <div className={styles['draftRow']}>
                <label className={styles['draftLabel']}>{t('draft.workspace')}</label>
                <select
                  className={styles['draftSelect']}
                  value={workspaceId}
                  onChange={(event) => {
                    workspacePicked.current = true
                    setWorkspaceId(event.target.value)
                  }}
                  disabled={busy}
                >
                  <option value={NEW_WORKSPACE}>{t('draft.newWorkspace')}</option>
                  {workspaceOptions.map(option => (
                    <option key={option.id} value={option.id}>{option.title}</option>
                  ))}
                </select>
              </div>
              {creatingWorkspace
                ? (
                    <div className={styles['draftRow']}>
                      <label className={styles['draftLabel']}>{t('draft.wsName')}</label>
                      <div className={styles['draftGrow']}>
                        <input
                          className={styles['draftInput']}
                          value={newWsName}
                          placeholder={t('draft.wsNamePlaceholder')}
                          onChange={(event) => { setNewWsName(event.target.value) }}
                          disabled={busy}
                        />
                        {newWsName.trim() !== ''
                          ? <div className={styles['draftPathPreview']}>{newWsPath}</div>
                          : null}
                      </div>
                    </div>
                  )
                : null}
              <div className={styles['draftRow']}>
                <label className={styles['draftLabel']}>{t('draft.model')}</label>
                <select
                  className={styles['draftSelect']}
                  value={modelKey}
                  onChange={(event) => { setModelKey(event.target.value) }}
                  disabled={busy}
                >
                  <option value="">
                    {defaultModelLabel !== '' ? `${defaultModelLabel}${t('draft.defaultSuffix')}` : t('draft.default')}
                  </option>
                  {groups.map(group => group.models.map(model => (
                    <option key={`${group.id}::${model.id}`} value={`${group.id}::${model.id}`}>
                      {group.name} · {model.name}
                    </option>
                  )))}
                </select>
              </div>
              {presets.length > 0
                ? (
                    <div className={styles['draftRow']}>
                      <label className={styles['draftLabel']}>{t('draft.preset')}</label>
                      <select
                        className={styles['draftSelect']}
                        value={presetId}
                        onChange={(event) => { setPresetId(event.target.value) }}
                        disabled={busy}
                      >
                        <option value="">
                          {defaultPresetLabel !== ''
                            ? `${defaultPresetLabel}${t('draft.defaultSuffix')}`
                            : t('draft.default')}
                        </option>
                        {presets.map(preset => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name ?? preset.id}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                : null}
            </>
          )
        : null}
      {mode === 'full' ? <div className={styles['spawnHint']}>{t('spawn.fullOptional')}</div> : null}
      {dragActive ? <div className={styles['draftDropHint']}>{t('draft.dropHint')}</div> : null}
      {attachments.length > 0
        ? (
            <div className={styles['draftAttachments']}>
              {attachments.map(attachment => attachment.kind === 'image'
                ? (
                    <div key={attachment.id} className={styles['draftAttachmentImage']}>
                      {attachment.previewUrl !== undefined
                        ? <img src={attachment.previewUrl} alt={attachment.file.name} />
                        : null}
                      {uploadProgress[attachment.id] !== undefined
                        ? (
                            <span className={styles['draftAttachmentProgress']} aria-hidden="true">
                              <span
                                className={styles['draftAttachmentProgressBar']}
                                style={{ width: `${Math.round((uploadProgress[attachment.id] ?? 0) * 100)}%` }}
                              />
                            </span>
                          )
                        : null}
                      <button
                        type="button"
                        className={styles['draftAttachmentRemove']}
                        title={t('draft.removeAttachment')}
                        aria-label={t('draft.removeAttachment')}
                        disabled={busy}
                        onClick={() => { removeAttachment(attachment.id) }}
                      >
                        ×
                      </button>
                    </div>
                  )
                : (
                    <div key={attachment.id} className={styles['draftAttachmentFile']}>
                      <svg
                        className={styles['draftAttachmentFileIcon']}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                        <path d="M14 3v5h5" />
                      </svg>
                      <span className={styles['draftAttachmentFileText']}>
                        <span className={styles['draftAttachmentFileName']}>
                          {attachment.file.name !== '' ? attachment.file.name : t('draft.untitledFile')}
                        </span>
                        <span className={styles['draftAttachmentFileMeta']}>
                          {formatAttachmentBytes(attachment.file.size)}
                        </span>
                      </span>
                      <button
                        type="button"
                        className={styles['draftAttachmentRemove']}
                        title={t('draft.removeAttachment')}
                        aria-label={t('draft.removeAttachment')}
                        disabled={busy}
                        onClick={() => { removeAttachment(attachment.id) }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
            </div>
          )
        : null}
      <textarea
        ref={textareaRef}
        className={styles['draftTextarea']}
        placeholder={t('draft.placeholder')}
        value={text}
        rows={4}
        onChange={(event) => { setText(event.target.value) }}
        onPaste={onPaste}
        onKeyDown={(event) => {
          // Enter sends (Shift+Enter = newline); an IME confirmation Enter
          // (Chinese candidate pick) must never send.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void create()
          }
        }}
        disabled={busy}
      />
      {error !== undefined ? <div className={styles['spawnError']}>{error}</div> : null}
      <div className={styles['spawnActions']}>
        <button type="button" className={styles['spawnBtnGhost']} onClick={props.onClose} disabled={busy}>
          {t('spawn.cancel')}
        </button>
        <button
          type="button"
          className={styles['spawnBtnPrimary']}
          onClick={() => { void create() }}
          disabled={sendDisabled}
        >
          {busy ? (uploadNote ?? t('spawn.busy')) : t('spawn.confirm')}
        </button>
      </div>
    </div>
  )
}
