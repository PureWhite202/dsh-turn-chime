/**
 * The pending-interaction popover: one small panel anchored under the card's
 * "needs you" button. It answers through the very same live interaction
 * object the host's composer card uses, so the Host request settles exactly
 * once no matter which surface answered it.
 *
 * Approval: Allow once / Reject.
 * Question / plan review: option buttons; a single single-select question
 * answers on click, while a multi-select or multi-question batch collects
 * choices and submits them together.
 * Anything the map cannot express (free-text questions, questions without
 * options) falls back to the right-hand conversation drawer.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PendingInteractionLike, PendingQuestionLike } from './dsh.ts'
import { interactions, type InteractionMenuState } from './interactions.ts'
import { mapUi } from './map-state.ts'
import { t } from './i18n.ts'
import styles from './talk-map.module.css'

export interface InteractionMenuProps {
  state: InteractionMenuState
  /** Canvas wrapper size, used to keep the panel inside the map. */
  wrapperWidth: number
  wrapperHeight: number
  onClose: () => void
  onOpenChat?: (sessionId: string) => void
}

export function InteractionMenu(props: InteractionMenuProps): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(interactions.subscribe, interactions.getSnapshot)
  const interaction = snapshot.get(props.state.sessionId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<Record<string, string[]>>({})

  // Esc closes this panel without closing the map underneath.
  useEffect(() => {
    const release = mapUi.claimEscape('interaction-menu')
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      props.onClose()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      release()
    }
  }, [])

  // The request can settle elsewhere (the composer card, another window, an
  // abort): the menu goes with it.
  useEffect(() => {
    if (interaction === undefined) props.onClose()
  }, [interaction])

  if (interaction === undefined) return null

  const panelWidth = Math.max(220, Math.min(280, props.wrapperWidth - 16))
  const left = Math.max(8, Math.min(props.state.left, props.wrapperWidth - panelWidth - 8))
  const estimatedHeight = 300
  const top = props.state.bottom + estimatedHeight > props.wrapperHeight
    ? Math.max(8, props.state.top - estimatedHeight - 6)
    : props.state.bottom + 6

  const settle = (action: () => unknown): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    Promise.resolve()
      .then(action)
      .then(() => { props.onClose() })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setBusy(false)
      })
  }

  const frame = (body: React.ReactNode): React.JSX.Element => (
    <div
      className={`${styles['menu']} ${styles['interactMenu']}`}
      style={{ left, top }}
      role="dialog"
      aria-label={t('interact.aria')}
      onClick={(event) => { event.stopPropagation() }}
      onPointerDown={(event) => { event.stopPropagation() }}
      onContextMenu={(event) => { event.preventDefault() }}
    >
      {body}
      {error !== undefined ? <div className={styles['interactError']}>{error}</div> : null}
    </div>
  )

  const answer = interaction.answer
  if (typeof answer !== 'function') {
    return frame(openChatBody(props, interaction))
  }

  if (interaction.kind === 'approval') {
    const reason = interaction.displayReason ?? interaction.reason
    return frame(
      <>
        <div className={styles['interactTitle']}>{t('interact.approvalTitle', { tool: interaction.toolName ?? '' })}</div>
        {reason !== undefined && reason !== ''
          ? <div className={styles['interactText']}>{reason}</div>
          : null}
        <div className={styles['interactActions']}>
          <button
            type="button"
            className={styles['interactAllow']}
            disabled={busy || interaction.answerable === false}
            onClick={() => { settle(() => interaction.answer?.('allowed-once')) }}
          >
            {busy ? t('interact.busy') : t('interact.allow')}
          </button>
          <button
            type="button"
            className={styles['interactDanger']}
            disabled={busy || interaction.answerable === false}
            onClick={() => { settle(() => interaction.answer?.('rejected')) }}
          >
            {t('interact.reject')}
          </button>
        </div>
      </>,
    )
  }

  const questions = interaction.questions ?? []
  const title = interaction.kind === 'plan-review' ? t('interact.planTitle') : t('interact.questionTitle')

  // Free-text questions and option-less questions have no answer the map can
  // express — hand over to the conversation's own composer card.
  if (questions.length === 0 || questions.some(question => (question.options?.length ?? 0) === 0)) {
    return frame(openChatBody(props, interaction))
  }

  if (questions.length === 1 && questions[0] !== undefined && questions[0].multiSelect !== true) {
    const question = questions[0]
    return frame(
      <>
        <div className={styles['interactTitle']}>{title}</div>
        <div className={styles['interactText']}>{question.question}</div>
        <div className={styles['interactOptions']}>
          {(question.options ?? []).map(option => (
            <button
              key={option.label}
              type="button"
              className={styles['interactOption']}
              title={option.description}
              disabled={busy || interaction.answerable === false}
              onClick={() => {
                settle(() => interaction.answer?.({ answers: [{ id: question.id, selected: [option.label] }] }))
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </>,
    )
  }

  const toggle = (question: PendingQuestionLike, label: string): void => {
    setSelected((previous) => {
      const current = previous[question.id] ?? []
      const next = question.multiSelect === true
        ? (current.includes(label) ? current.filter(item => item !== label) : [...current, label])
        : [label]
      return { ...previous, [question.id]: next }
    })
  }

  const allChosen = questions.every(question => (selected[question.id]?.length ?? 0) > 0)
  const submit = (): void => {
    const answers = questions.map(question => ({ id: question.id, selected: selected[question.id] ?? [] }))
    settle(() => interaction.answer?.({ answers }))
  }

  return frame(
    <>
      <div className={styles['interactTitle']}>{title}</div>
      <div className={styles['interactScroll']}>
        {questions.map(question => (
          <div key={question.id} className={styles['interactGroup']}>
            <div className={styles['interactText']}>{question.question}</div>
            <div className={styles['interactOptions']}>
              {(question.options ?? []).map(option => {
                const active = (selected[question.id] ?? []).includes(option.label)
                return (
                  <button
                    key={option.label}
                    type="button"
                    className={`${styles['interactOption']}${active ? ` ${styles['interactOptionActive']}` : ''}`}
                    title={option.description}
                    disabled={busy || interaction.answerable === false}
                    onClick={() => { toggle(question, option.label) }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={styles['interactSubmit']}
        disabled={busy || !allChosen || interaction.answerable === false}
        onClick={submit}
      >
        {busy ? t('interact.busy') : t('interact.submit')}
      </button>
    </>,
  )
}

/** Fallback body: the decision needs the full conversation surface. */
function openChatBody(props: InteractionMenuProps, interaction: PendingInteractionLike): React.ReactNode {
  const question = interaction.questions?.[0]?.question
  return (
    <>
      <div className={styles['interactTitle']}>{t('interact.questionTitle')}</div>
      <div className={styles['interactText']}>{question ?? t('interact.needsChat')}</div>
      <div className={styles['interactNote']}>{t('interact.needsChatHint')}</div>
      <button
        type="button"
        className={styles['interactOpen']}
        onClick={() => {
          props.onClose()
          props.onOpenChat?.(props.state.sessionId)
        }}
      >
        {t('interact.openChat')}
      </button>
    </>
  )
}
