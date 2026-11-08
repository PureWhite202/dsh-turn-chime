/**
 * The draft card: double-clicking empty canvas opens this in-place composer
 * node instead of jumping into the conversation UI. Nothing exists until 发送
 * — then (optionally) a workspace is created, a session is created in it,
 * the optional model selection is applied, the first prompt is queued, and
 * the draft turns into a normal card at the same spot. The user stays on the
 * map; the running dot shows progress.
 *
 * Defaults are shown as real values (via /talk-map/defaults): the default
 * model route and the deployment's default agent preset. Double-clicking
 * inside a workspace frame preselects that workspace; anywhere else the
 * selector defaults to creating a new workspace.
 */
import { useEffect, useRef, useState } from 'react'
import type { NodeProps, Node } from '@xyflow/react'
import type { AgentPresetEntry, ModelProviderGroup, RemoteService } from './dsh.ts'
import type { EdgeInjection } from '../shared/model.ts'
import { talkMapApi } from './api.ts'
import { canvas, INBOX_BOARD_ID, newCardId } from './canvas-store.ts'
import { getServices, mapUi, openSessionInMain, sessionIdOf, unwrapRemote } from './map-state.ts'
import { buildInjectionText, digestIsEmpty } from './digest-text.ts'
import { t } from './i18n.ts'
import styles from './talk-map.module.css'

/** Source of a connection-drag draft: the card the fork starts from. */
export interface DraftParent {
  cardId: string
  sessionId: string
  title: string
  workspaceId?: string
}

export interface DraftCardData extends Record<string, unknown> {
  /** Workspaces to choose from (id + display title + path), map-order. */
  workspaceOptions: { id: string; title: string; path: string }[]
  /** Preselected workspace (set when the double-click landed inside a frame). */
  defaultWorkspaceId?: string
  /** Map group the draft was opened in — the new card's frame membership. */
  groupId?: string
  /** When set, this draft is a fork box: it carries the source's summary and
   *  offers digest / full-history / no-inheritance modes. */
  parent?: DraftParent
  onClose: () => void
  /** Open the newborn Session in the map's right-hand drawer (keeps the map
   *  open). Absent on older hosts: the draft then jumps to the full view. */
  onOpenChat?: (sessionId: string) => void
}

export type DraftCardNodeType = Node<DraftCardData, 'draftCard'>

const NEW_WORKSPACE = '__new__'
const GRID = 16
const snap = (value: number): number => Math.round(value / GRID) * GRID

/**
 * Workspace a map-born conversation lands in when the draft was opened on
 * bare canvas (outside every workspace frame): the deployment's own
 * `default-workspace`, matched by title or directory name. The host keeps
 * that workspace as its default; the map mirrors it instead of silently
 * offering to create yet another workspace.
 */
function defaultWorkspaceOption(options: DraftCardData['workspaceOptions']): string | undefined {
  const dirName = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/, '')
    const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
    return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).toLowerCase()
  }
  const match = options.find(option =>
    option.title.trim().toLowerCase() === 'default-workspace'
    || dirName(option.path) === 'default-workspace')
  return match?.id
}

/** Localized copy for a shipped preset id; custom presets render their name. */
function presetDisplayName(id: string): string {
  const key = `preset.${id}`
  const label = t(key)
  return label === key ? id : label
}

/** Parent directory new workspaces land in: alongside the existing ones. */
function newWorkspaceParent(options: { path: string }[]): string {
  const sample = options[0]?.path
  if (sample === undefined) return '~'
  const cut = sample.lastIndexOf('/')
  return cut > 0 ? sample.slice(0, cut) : sample
}

export function DraftCardNode(props: NodeProps<DraftCardNodeType>): React.JSX.Element {
  const { data } = props
  const [workspaceId, setWorkspaceId] = useState(
    data.defaultWorkspaceId ?? defaultWorkspaceOption(data.workspaceOptions) ?? NEW_WORKSPACE,
  )
  /** Whether the user picked a workspace themselves (then never override it). */
  const workspacePicked = useRef(false)
  const [newWsName, setNewWsName] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [presetId, setPresetId] = useState('')
  const [text, setText] = useState('')
  const parent = data.parent
  const [mode, setMode] = useState<'digest' | 'full' | 'none'>('digest')
  const [summary, setSummary] = useState(() => parent === undefined
    ? ''
    : buildInjectionText(parent.title, canvas.get().digests[parent.sessionId]))
  const [groups, setGroups] = useState<ModelProviderGroup[]>([])
  const [presets, setPresets] = useState<readonly AgentPresetEntry[]>([])
  const [defaultModelLabel, setDefaultModelLabel] = useState('')
  const [defaultPresetLabel, setDefaultPresetLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
    const release = mapUi.claimEscape('draft-card')
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        data.onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Workspace options can arrive after the draft mounts: adopt the
  // default-workspace then, unless the user already chose something.
  useEffect(() => {
    if (data.defaultWorkspaceId !== undefined || workspacePicked.current) return
    const fallback = defaultWorkspaceOption(data.workspaceOptions)
    if (fallback === undefined) return
    setWorkspaceId(previous => (previous === NEW_WORKSPACE ? fallback : previous))
  }, [data.defaultWorkspaceId, data.workspaceOptions])

  useEffect(() => {
    const services = getServices()
    const remote = services?.remote
    // The gateway can briefly lack its Remote namespaces while (re)connecting;
    // a throw here used to crash the whole shell.overlay slot entry.
    if (remote === undefined) return
    try {
      remote.session.modelCatalog().then((result) => {
        if (result.ok) setGroups(result.value.groups ?? [])
      }).catch(() => undefined)
      remote.agentPresets.list().then((result) => {
        if (result.ok) {
          const list = result.value.presets
          setPresets(list)
          // Prefer the plain "standard" preset for map-born conversations —
          // the deployment default may be a specialized mode (e.g. cordis).
          if (list.some(preset => preset.id === 'standard')) {
            setPresetId(previous => (previous === '' ? 'standard' : previous))
          }
        }
      }).catch(() => undefined)
    } catch (error) {
      console.warn('[dsh-talk-map] model catalog unavailable:', error)
    }
    talkMapApi.getDefaults().then((defaults) => {
      if (defaults.model !== null) setDefaultModelLabel(defaults.model.model)
      if (defaults.preset !== null) setDefaultPresetLabel(defaults.preset)
    }).catch(() => undefined)
  }, [])

  const creatingWorkspace = workspaceId === NEW_WORKSPACE
  const wsParent = newWorkspaceParent(data.workspaceOptions)
  const newWsPath = `${wsParent}/${newWsName.trim()}`
  const isFork = parent !== undefined
  const needsNewWorkspaceName = (!isFork || mode !== 'full') && creatingWorkspace && newWsName.trim() === ''
  const sendDisabled = busy
    || (isFork
      ? (mode === 'digest' && (summary.trim() === '' || text.trim() === ''))
        || (mode === 'none' && text.trim() === '')
        || needsNewWorkspaceName
      : text.trim() === '' || needsNewWorkspaceName)

  /** Resolve the destination workspace, creating the folder/workspace on demand. */
  const resolveTargetWorkspace = async (remote: RemoteService): Promise<string> => {
    if (workspaceId !== NEW_WORKSPACE) return workspaceId
    // dsh only registers existing directories — create the folder first.
    await talkMapApi.ensureDir(newWsPath)
    const created = unwrapRemote<{ workspace: { workspaceId: string } }>(
      await remote.workspace.create({ path: newWsPath }),
      'workspace.create',
    )
    return created.workspace.workspaceId
  }

  /** The default workspace stays unframed; other workspaces grow a frame on
   *  first use, matching the legacy draft flow. */
  const ensureFrame = (targetWorkspaceId: string, cardX: number, cardY: number): void => {
    const defaultWsId = defaultWorkspaceOption(data.workspaceOptions)
    if (targetWorkspaceId === defaultWsId) return
    if (canvas.get().global?.wsFrames?.[targetWorkspaceId] !== undefined) return
    const CARD_W = 224
    const CARD_H = 120
    const PAD = 32
    const LABEL = 30
    canvas.setWsFrameRect(targetWorkspaceId, {
      x: cardX - PAD,
      y: cardY - PAD - LABEL,
      width: CARD_W + PAD * 2,
      height: CARD_H + PAD * 2 + LABEL,
    })
  }

  /** Add the newborn card at the draft's exact spot; returns its card id. */
  const addDraftCard = (sessionId: string, wsOverride: string | undefined): string => {
    const cardId = newCardId()
    canvas.addCards({
      [cardId]: {
        boardId: INBOX_BOARD_ID,
        sessionId,
        x: snap(props.positionAbsoluteX),
        y: snap(props.positionAbsoluteY),
        ...(wsOverride !== undefined && wsOverride !== '' ? { wsOverride } : {}),
        createdAt: Date.now(),
      },
    })
    return cardId
  }

  /** Persist the fork relationship as a map edge (digest/full/none). */
  const addForkEdge = (
    parentCardId: string,
    toCardId: string,
    kind: EdgeInjection['kind'],
    injectedText: string | undefined,
  ): void => {
    canvas.addEdges({
      [`edge-${crypto.randomUUID()}`]: {
        boardId: INBOX_BOARD_ID,
        fromCardId: parentCardId,
        toCardId,
        injection: { kind, ...(injectedText !== undefined ? { injectedText } : {}) },
        createdAt: Date.now(),
      },
    })
  }

  const sendPrompt = async (remote: RemoteService, sessionId: string, promptText: string): Promise<void> => {
    unwrapRemote<void>(await remote.session.prompt({
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }), 'session.prompt')
  }

  const finish = (sessionId: string): void => {
    data.onClose()
    // The newborn conversation opens in the map's right-hand drawer; the map
    // stays exactly where it was.
    if (data.onOpenChat !== undefined) {
      data.onOpenChat(sessionId)
    } else {
      mapUi.setOpen(false)
      openSessionInMain(sessionId)
    }
  }

  const send = async (): Promise<void> => {
    const services = getServices()
    if (services === undefined || sendDisabled) return
    setBusy(true)
    setError(undefined)
    try {
      const remote = services.remote
      const createSession = services.sessions.create
      if (remote === undefined || createSession === undefined) {
        throw new Error('dsh connection is not ready')
      }

      // ---- fork draft: the draft is a box dragged out of a source card ----
      if (parent !== undefined) {
        const cardX = snap(props.positionAbsoluteX)
        const cardY = snap(props.positionAbsoluteY)
        if (mode === 'full') {
          // dsh-native fork: the child carries the source's full history.
          const forked = unwrapRemote(await services.sessions.fork({ sessionId: parent.sessionId }), 'session.fork')
          const childId = sessionIdOf(forked)
          if (childId === undefined) throw new Error('session.fork returned no session id')
          const forkCardId = addDraftCard(childId, parent.workspaceId)
          addForkEdge(parent.cardId, forkCardId, 'full', undefined)
          if (parent.workspaceId !== undefined) ensureFrame(parent.workspaceId, cardX, cardY)
          if (text.trim() !== '') await sendPrompt(remote, childId, text)
          finish(childId)
          return
        }
        const targetWorkspaceId = await resolveTargetWorkspace(remote)
        const createResult = await createSession.call(services.sessions, {
          workspaceId: targetWorkspaceId,
          ...(presetId !== '' ? { agentPreset: presetId } : {}),
        })
        const sessionId = sessionIdOf(unwrapRemote(createResult, 'session.create'))
        if (sessionId === undefined) throw new Error('session.create returned no session id')
        if (mode === 'digest') {
          // Background first, then the user's opening message.
          await talkMapApi.injectContext(sessionId, [{ sessionId: parent.sessionId, text: summary }])
        }
        const cardId = addDraftCard(sessionId, targetWorkspaceId)
        addForkEdge(parent.cardId, cardId, mode === 'digest' ? 'digest' : 'none', mode === 'digest' ? summary : undefined)
        ensureFrame(targetWorkspaceId, cardX, cardY)
        if (modelKey !== '') {
          const [provider, model] = modelKey.split('::') as [string, string]
          unwrapRemote<void>(await remote.session.selectModel({ sessionId, provider, model }), 'session.selectModel')
        }
        if (text.trim() !== '') await sendPrompt(remote, sessionId, text)
        finish(sessionId)
        return
      }

      // ---- plain new conversation (no source card) ----
      const targetWorkspaceId = await resolveTargetWorkspace(remote)
      const createResult = await createSession.call(services.sessions, {
        workspaceId: targetWorkspaceId,
        ...(presetId !== '' ? { agentPreset: presetId } : {}),
      })
      const sessionId = sessionIdOf(unwrapRemote(createResult, 'session.create'))
      if (sessionId === undefined) throw new Error('session.create returned no session id')
      const cardX = snap(props.positionAbsoluteX)
      const cardY = snap(props.positionAbsoluteY)
      addDraftCard(sessionId, targetWorkspaceId)
      ensureFrame(targetWorkspaceId, cardX, cardY)
      if (modelKey !== '') {
        const [provider, model] = modelKey.split('::') as [string, string]
        unwrapRemote<void>(await remote.session.selectModel({ sessionId, provider, model }), 'session.selectModel')
      }
      await sendPrompt(remote, sessionId, text)
      finish(sessionId)
    } catch (sendError) {
      setError(String(sendError))
      setBusy(false)
    }
  }

  const forkModes: { id: 'digest' | 'full' | 'none'; label: string }[] = [
    { id: 'digest', label: t('spawn.mode.digest') },
    { id: 'full', label: t('spawn.mode.full') },
    { id: 'none', label: t('spawn.mode.none') },
  ]
  const parentDigest = parent !== undefined ? canvas.get().digests[parent.sessionId] : undefined
  const digestEmpty = parentDigest === undefined || digestIsEmpty(parentDigest)
  const showConfig = !isFork || mode !== 'full'

  return (
    <div
      className={styles['draftCard']}
      role="dialog"
      aria-label={t(isFork ? 'spawn.heading' : 'draft.heading')}
      // Form controls own their pointer events entirely: React Flow's node
      // machinery must never see them, or the native <select> dropdown opens
      // and instantly closes (the flash-close bug).
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('select, textarea, input, button') !== null) event.stopPropagation()
      }}
      onMouseDownCapture={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('select, textarea, input, button') !== null) event.stopPropagation()
      }}
    >
      <div className={styles['draftHeading']}>{t(isFork ? 'spawn.heading' : 'draft.heading')}</div>
      {isFork && parent !== undefined
        ? (
            <>
              <div className={styles['spawnFrom']}>{t('spawn.from')}「{parent.title}」</div>
              <div className={styles['spawnModes']}>
                {forkModes.map(entry => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`${styles['spawnModeBtn']}${mode === entry.id ? ` ${styles['spawnModeActive']}` : ''}`}
                    onClick={() => { setMode(entry.id) }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              {mode === 'digest'
                ? (
                    <>
                      <div className={styles['spawnHint']}>{t('spawn.hint')}</div>
                      <textarea
                        className={`${styles['spawnTextarea']} nodrag nowheel`}
                        value={summary}
                        rows={6}
                        onChange={(event) => { setSummary(event.target.value) }}
                      />
                      {digestEmpty ? <div className={styles['spawnHint']}>{t('spawn.noDigest')}</div> : null}
                    </>
                  )
                : mode === 'none'
                  ? <div className={styles['spawnHint']}>{t('spawn.noneHint')}</div>
                  : <div className={styles['spawnHint']}>{t('spawn.fullHint')}</div>}
            </>
          )
        : null}
      {showConfig
        ? (
            <>
      <div className={styles['draftRow']}>
        <label className={styles['draftLabel']}>{t('draft.workspace')}</label>
        <select
          className={`${styles['draftSelect']} nodrag`}
          value={workspaceId}
          onChange={(event) => {
            workspacePicked.current = true
            setWorkspaceId(event.target.value)
          }}
        >
          <option value={NEW_WORKSPACE}>{t('draft.newWorkspace')}</option>
          {data.workspaceOptions.map(option => (
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
                  className={`${styles['draftInput']} nodrag`}
                  value={newWsName}
                  placeholder={t('draft.wsNamePlaceholder')}
                  onChange={(event) => { setNewWsName(event.target.value) }}
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
          className={`${styles['draftSelect']} nodrag`}
          value={modelKey}
          onChange={(event) => { setModelKey(event.target.value) }}
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
                className={`${styles['draftSelect']} nodrag`}
                value={presetId}
                onChange={(event) => { setPresetId(event.target.value) }}
              >
                <option value="">
                  {defaultPresetLabel !== ''
                    ? `${presetDisplayName(defaultPresetLabel)}${t('draft.defaultSuffix')}`
                    : t('draft.default')}
                </option>
                {presets.map(preset => (
                  <option key={preset.id} value={preset.id}>{preset.name ?? presetDisplayName(preset.id)}</option>
                ))}
              </select>
            </div>
          )
        : null}
            </>
          )
        : null}
      {isFork && mode === 'full' ? <div className={styles['spawnHint']}>{t('spawn.fullOptional')}</div> : null}
      <textarea
        ref={textareaRef}
        className={`${styles['draftTextarea']} nodrag nowheel`}
        placeholder={t('draft.placeholder')}
        value={text}
        rows={4}
        onChange={(event) => { setText(event.target.value) }}
        onKeyDown={(event) => {
          // Enter sends (Shift+Enter = newline); an IME confirmation Enter
          // (Chinese candidate pick) must never send.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }}
      />
      {error !== undefined ? <div className={styles['spawnError']}>{error}</div> : null}
      <div className={styles['spawnActions']}>
        <button type="button" className={`${styles['spawnBtnGhost']} nodrag`} onClick={data.onClose} disabled={busy}>
          {t('spawn.cancel')}
        </button>
        <button
          type="button"
          className={`${styles['spawnBtnPrimary']} nodrag`}
          onClick={() => { void send() }}
          disabled={sendDisabled}
        >
          {busy
            ? (isFork ? t('spawn.busy') : t('draft.sending'))
            : (isFork ? t('spawn.confirm') : t('draft.send'))}
        </button>
      </div>
    </div>
  )
}
