/**
 * Structural contracts for the DSH client-runtime surfaces this plugin
 * touches. Deliberately NOT imported from @deepseek-ai packages: this plugin
 * builds out-of-tree against rc-stage APIs, and a structural subset keeps the
 * compile surface pinned to exactly what we call (the pattern proven by
 * dsh-plugin-market). Source of truth — verify on dsh upgrades:
 *   packages/client/runtime/src/client/contract/sessions.ts
 *   packages/client/runtime/src/client/sessions/service.ts   (SessionSummary)
 *   packages/client/runtime/src/client/workspaces/service.ts
 *   packages/client/ui-slots/src/store.ts                    (SnapshotSelectorHook)
 *   packages/client/ui-layout/src/client/index.ts            ('shell.overlay')
 *   packages/client/ui-sidebar/src/client/contract/slots.ts  ('sidebar.footer.action')
 * all @ deepseek-harness 0.2.2-rc.1 (draft attachments also require the
 * web-app bundle's dsh-client-file-upload and dsh-client-ui-file-drag entries).
 */

/** Selector hook a slot's standard props deliver (subscribes the component). */
export type SnapshotSelectorHook<T> = <S>(sel: (state: T) => S, eq?: (a: S, b: S) => boolean) => S

/** Raster image types the Host accepts as prompt images. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * Browser-submitted prompt content (dsh-api-session-controller/types
 * `PromptContentPart`). Image parts carry base64 bytes the Host promotes to a
 * durable reference; file parts cite the receipt of an upload made on the
 * same Session — an image upload's receipt enters the message as that image.
 */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
  | { type: 'file'; receiptId: string }

/** Byte progress reported while one browser upload is consumed. */
export interface FileUploadProgress {
  readonly loaded: number
  readonly total?: number
}

/** Staged-receipt half of one completed upload (the rest is display data). */
export interface FileUploadReceipt {
  readonly receiptId: string
}

/**
 * ctx.fileUpload (subset of the dsh-client-file-upload contract): store one
 * file or prompt image for a Session and return the receipt a later prompt
 * cites. Addresses the raw route and falls back to the generated Remote.
 */
export interface FileUploadService {
  upload(
    sessionId: string,
    data: Blob,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<RemoteResult<FileUploadReceipt>>
  uploadImage(
    sessionId: string,
    data: Blob,
    mediaType: ImageMediaType,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<RemoteResult<FileUploadReceipt>>
}

/** ctx.fileDrag.read: original bytes of an application-internal file drag. */
export interface FileDragService {
  read(transfer: DataTransfer): File | undefined
}

/** One row of the sessions list feed (subset of SessionSummary we render). */
export interface SessionSummary {
  readonly id: string
  readonly title?: string
  readonly displayTitle: string
  readonly cwd?: string
  readonly agentPreset?: string
  /** Fork/subagent lineage — the free provenance edge on the map. */
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly running: boolean
  /** User interaction currently blocking this session (approval/question). */
  readonly pendingInteraction?: unknown
  /** Finished while not selected and not yet opened — the "done, unread" state. */
  readonly completed?: boolean
  readonly blank: boolean
  readonly updatedAt: number
  /** Retain-source counts; `mainView > 0` marks the Session on screen. */
  readonly retainedBy?: {
    readonly mainView?: number
    readonly [source: string]: number | undefined
  }
}

/** The useSessions standard feed (subset). */
export interface SessionListState {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummary>>
  readonly current?: string
}

/** The useWorkspaces standard feed (subset of WorkspaceListState/WorkspaceView). */
export interface WorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}
export interface WorkspaceListState {
  readonly items: readonly WorkspaceView[]
  readonly recentWorkspaceId: string | undefined
  readonly baselinesReady?: boolean
}

/** Standard props every root-scope slot component receives. */
export interface RootSlotStandardProps {
  useSessions: SnapshotSelectorHook<SessionListState>
  useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
}

/** Owner share of a 'sidebar.footer.action' entry. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Child-slot declaration on a slot entry (subset of the runtime's spec). */
export interface SlotChildSpec {
  kind?: 'single' | 'list' | 'chain'
  scope?: 'root' | 'session'
}

/** Slot registration options (subset of the register() surface we use). */
export interface SlotEntryOptions {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
  inject?: (...args: unknown[]) => unknown
  /** Declaring a session-scoped child makes the runtime inject the
   *  `renderSlot`/`renderFactorySlot`/`SessionProvider` kit into the entry
   *  component (the same kit `ui-subagent` uses for embedded conversations). */
  children?: Record<string, SlotChildSpec>
}

/** ctx.slots — inject defers until the slot is declared; register returns a disposer. */
export interface SlotsService {
  inject(name: string, factory: () => (() => void) | Iterable<() => void>): void
  register(entry: SlotEntryOptions, component: unknown): () => void
}

/** One retained Client session generation (subset; release is idempotent). */
export interface SessionReference {
  release(): void
}

/** One selectable option of a pending question. */
export interface PendingOptionLike {
  readonly label: string
  readonly description?: string
}

/** One question inside a pending question batch. */
export interface PendingQuestionLike {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly multiSelect?: boolean
  readonly options?: readonly PendingOptionLike[]
  readonly intent?: { readonly kind?: string; readonly approve?: string }
}

/**
 * A live, Session-owned interaction waiting for the user (approval, question,
 * or plan review). These are the very objects the host's own composer cards
 * drive: `answer()` settles the waiting Host request, so the map can offer the
 * same decision without any extra plumbing. Structural contract only.
 */
export interface PendingInteractionLike {
  readonly kind: 'approval' | 'question' | 'plan-review' | string
  readonly sessionId?: string
  readonly key?: string
  readonly answerable?: boolean
  readonly toolName?: string
  readonly reason?: string
  readonly displayReason?: string
  readonly questions?: readonly PendingQuestionLike[]
  answer?(value: unknown): unknown
}

/** One Session's live status row (subset of the runtime's SessionStatus). */
export interface SessionStatusLike {
  readonly pendingInteraction?: PendingInteractionLike
  /** Finished while not selected/unread — the sidebar's green completed dot. */
  readonly completionUnread?: boolean
}

/** ctx.uiSession (subset): the observable Session-status store. */
export interface UiSessionService {
  readonly sessionStatus: {
    getSnapshot(): ReadonlyMap<string, SessionStatusLike>
    subscribe(listener: () => void): () => void
  }
}

/** ctx.sessions (ISessions subset). */
export interface SessionsService {
  readonly list: {
    getSnapshot(): SessionListState
    subscribe(listener: () => void): () => void
  }
  open?(id: string): void
  clear?(): void
  /** Controller create: also merges the newborn Session into the catalog. */
  create?(opts?: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  }): Promise<RemoteResult<{ sessionId: string }>>
  fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }):
    Promise<RemoteResult<{ sessionId: string }>>
  /** Retain one live Session generation and start opening its history.
   *  Absent on hosts that predate client references (0.1.x): the map then
   *  keeps the old "open the session" behavior instead of the side panel. */
  retain?(target: string, options: { source: string; signal?: AbortSignal }): SessionReference
}

/** One Remote result envelope (api-gateway client): no nested `result`. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code?: string; readonly message?: string } }

/** Generated Remote namespaces this plugin calls (subset of ctx.remote). */
export interface RemoteService {
  session: {
    create(payload: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }):
      Promise<RemoteResult<{ sessionId: string }>>
    prompt(payload: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: PromptContentPart[]
      clientTimeZone?: string
    }): Promise<RemoteResult<unknown>>
    selectModel(payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string }):
      Promise<RemoteResult<unknown>>
    modelCatalog(): Promise<RemoteResult<{ groups?: ModelProviderGroup[] }>>
    /** Host route (dsh-host-open-in-app): open one absolute path with the
     *  desktop's default application, or reveal it in the file manager.
     *  Optional — absent on hosts without the desktop bridge. */
    openWorkspacePath?(payload: { path: string; action?: 'reveal' }): Promise<RemoteResult<unknown>>
  }
  agentPresets: {
    list(): Promise<RemoteResult<{ presets: AgentPresetEntry[] }>>
  }
  workspace: {
    create(payload: { path: string }): Promise<RemoteResult<{ workspace: { workspaceId: string } }>>
  }
}

/** ctx.workspaces (subset): connectWorkspace reuses-or-creates the blank session. */
export interface WorkspacesService {
  connectWorkspace(workspaceId: string): Promise<string>
  startSession(workspaceId?: string): void
  /** Remote-backed Workspace state model (controller `list`). */
  list?: {
    getSnapshot(): {
      readonly archivedSessionIds?: readonly string[]
      /** Sessions the user pinned; they front their workspace list. */
      readonly pinnedSessionIds?: readonly string[]
    }
    subscribe?(listener: () => void): () => void
  }
  /** Archived Sessions reject new turns host-side; unarchive restores them. */
  unarchiveSession?(sessionId: string): Promise<RemoteResult<{ archivedSessionIds: readonly string[] }>>
}

/**
 * ctx.uiWorkspace (subset): the host's own session selection. The session
 * *runtime* service (`ctx.sessions`) only owns the catalog and retained
 * references in 0.2.x — view selection lives here.
 */
export interface UiWorkspaceService {
  openSession(sessionId: string): void
  /** Toggle the host's own sidebar pin (置顶会话); rejects on failure.
   *  Absent on hosts whose sidebar has no pin action. */
  pinSession?(sessionId: string): Promise<unknown>
  unpinSession?(sessionId: string): Promise<unknown>
  /** Close the Session the main column is showing (host-internal: the host
   *  itself calls it when archiving the visible Session). Resolves the map's
   *  "two editable occurrences of one Session" conflict by leaving the main
   *  column empty while the map owns the conversation surface. */
  clearMain?(): void
}

/** RPC envelopes (packages/host/apiproxy/src/api/rpc.ts): the fetch client
 * resolves RpcResponse — the ok/value union sits under `.result`. */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message?: string } }
export interface RpcEnvelope<T> {
  rpcId: string
  result: RpcResult<T>
}

/** One advisory model entry / provider group (session.models / llm.models). */
export interface ModelCatalogModel {
  id: string
  name: string
  reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
}
export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface AgentPresetEntry {
  id: string
  name?: string
  description?: string
}

/**
 * ctx.connection — the shared typed RPC client (ConnectionHandle.api subset;
 * packages/client/connection + packages/host/apiproxy/src/fetch/client.ts).
 */
export interface ConnectionService {
  api: {
    sessions: {
      create(payload: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }):
      Promise<RpcEnvelope<{ sessionId: string; agentPreset?: string }>>
      models(payload: { sessionId: string }):
      Promise<RpcEnvelope<{ current: unknown; groups?: ModelProviderGroup[] }>>
      selectModel(payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string }):
      Promise<RpcEnvelope<{ selected: unknown }>>
      prompt(payload: {
        sessionId: string
        mode: 'queue' | 'steer'
        content: { type: 'text'; text: string }[]
        clientTimeZone?: string
      }): Promise<RpcEnvelope<{ accepted: true }>>
    }
    workspace: {
      create(payload: { path: string }):
      Promise<RpcEnvelope<{ workspace: WorkspaceView; created: boolean }>>
    }
    llm: {
      models(payload: Record<string, never>):
      Promise<RpcEnvelope<{ groups: ModelProviderGroup[] }>>
    }
    agentPresets: {
      list(payload: Record<string, never>):
      Promise<RpcEnvelope<{ presets: readonly AgentPresetEntry[]; authorable: boolean; hasDocument: boolean }>>
    }
  }
}

/**
 * ctx.sidebarRight (subset): the host's right-Sidebar navigation controller.
 * Its `require()` refuses every open while no Session is on the main column —
 * exactly the map's own state, so the map wraps these two methods.
 */
export interface SidebarRightService {
  openResource(address: string, options?: unknown): void
  openTab(kind: string, options?: unknown): void
}

/** The client cordis context surface this plugin relies on (structural). */
export interface TalkMapClientContext {
  slots: SlotsService
  sessions: SessionsService
  workspaces: WorkspacesService
  connection: ConnectionService
  /** Generated Remote namespaces (api-gateway). */
  remote?: RemoteService
  /** Host session selection (main conversation). */
  uiWorkspace?: UiWorkspaceService
  /** Live per-Session status (running / pending interaction). Optional on
   *  hosts that predate the ui-session service. */
  uiSession?: UiSessionService
  /** Official browser upload service (dsh-client-file-upload). */
  fileUpload: FileUploadService
  /** Official application-internal file drag service (dsh-client-ui-file-drag). */
  fileDrag: FileDragService
  /** Cross-plugin right-Sidebar face; provided by the ui-sidebar-right bundle. */
  sidebarRight?: SidebarRightService
  /** Service lookup by name (cordis `ctx.get`), for services provided later. */
  get?: (name: string) => unknown
  /** Dynamic injection (cordis `ctx.inject`): runs when the named service
   *  appears, so the wrapper also installs without a hard dependency. */
  inject?: (names: string[], callback: (scope: { sidebarRight?: unknown }) => unknown) => unknown
  effect(callback: () => unknown, label?: string): void
}
