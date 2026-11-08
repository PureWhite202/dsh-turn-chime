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
 * all @ deepseek-harness 0.1.0-rc.6.
 */

/** Selector hook a slot's standard props deliver (subscribes the component). */
export type SnapshotSelectorHook<T> = <S>(sel: (state: T) => S, eq?: (a: S, b: S) => boolean) => S

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
      content: { type: 'text'; text: string }[]
      clientTimeZone?: string
    }): Promise<RemoteResult<unknown>>
    selectModel(payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string }):
      Promise<RemoteResult<unknown>>
    modelCatalog(): Promise<RemoteResult<{ groups?: ModelProviderGroup[] }>>
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
  effect(callback: () => unknown, label?: string): void
}
