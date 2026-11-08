/**
 * The drawer body: one concrete Session's conversation, rendered through the
 * host's own embedded occurrence — SessionProvider binds the target Session
 * and `conversation.content` paints the exact transcript + composer the
 * Conversation column uses. This mirrors the pattern
 * `@deepseek-ai/dsh-client-ui-subagent` relies on for chats in the right
 * Sidebar (that package is the reference for this contract).
 *
 * Everything here is framework-injected: the session-scoped slot supplies
 * `useSession` / `useConversation` / `useSessions` and `renderFactorySlot`,
 * so this plugin never imports host UI internals.
 */
import type { SessionListState } from './dsh.ts'
import styles from './talk-map.module.css'

/** Session view fields the embedded occurrence's phase decision reads. */
interface ChatSessionView {
  readonly id?: string
  readonly blank?: boolean
  readonly awaitingFirstTurn?: boolean
  readonly running?: boolean
  readonly promptAttempted?: boolean
  readonly openState?: string
}

/** Toolkit the session-scoped slot receives from the renderer. */
export interface ChatPanelProps {
  /** The Session to render, passed alongside the SessionProvider binding. */
  sessionId: string
  useSession: <S>(selector: (session: ChatSessionView) => S) => S
  useConversation: <S>(selector: (state: { activeTargets: ReadonlySet<string> }) => S) => S
  useSessions: <S>(selector: (state: SessionListState) => S) => S
  renderFactorySlot: (
    name: string,
    props: Record<string, unknown>,
    options: { slots?: Record<string, unknown> },
  ) => React.ReactNode
}

/** A View selector that always renders the plain Chat transcript. */
function ChatOnlyView(
  props: { renderSlot: (name: string, props?: Record<string, unknown>) => React.ReactNode },
): React.JSX.Element {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

export function ChatPanel(props: ChatPanelProps): React.JSX.Element {
  const session = props.useSession(value => value)
  const activeTargets = props.useConversation(value => value.activeTargets)
  const summaryBlank = props.useSessions(state => state.byId[props.sessionId]?.blank)

  // The same shell-phase derivation the host's embedded occurrence uses:
  // blank/engaging/active decides hero vs. transcript, and a loading blank
  // Session shows the settling state instead of the hero.
  const shellPhase = activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running === true
    ? 'active'
    : session.promptAttempted === true ? 'engaging' : 'blank'
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)

  return (
    <div className={styles['chatPanel']}>
      {props.renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : hero ? 'hero' : 'active',
        hero,
      }, { slots: { views: ChatOnlyView } })}
    </div>
  )
}
