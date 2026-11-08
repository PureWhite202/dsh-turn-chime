/**
 * Last-resort guard for the map surface. A single bad effect or render inside
 * the map must never take down the whole `shell.overlay` slot entry: a crashed
 * entry stays blank and the sidebar button cannot reopen it until the slot
 * re-registers. This boundary catches the throw, logs it, and leaves the map
 * itself closeable/retryable.
 */
import { Component, type ReactNode } from 'react'
import { t } from './i18n.ts'
import styles from './talk-map.module.css'

interface MapErrorBoundaryState {
  readonly error?: unknown
}

export class MapErrorBoundary extends Component<{ children: ReactNode }, MapErrorBoundaryState> {
  state: MapErrorBoundaryState = {}

  static getDerivedStateFromError(error: unknown): MapErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown): void {
    console.error('[dsh-talk-map] map render failed:', error)
  }

  render(): ReactNode {
    if (this.state.error === undefined) return this.props.children
    return (
      <div className={styles['mapFallback']} role="alert">
        <div className={styles['mapFallbackTitle']}>{t('map.crash')}</div>
        <div className={styles['mapFallbackText']}>{t('map.crashHint')}</div>
        <button
          type="button"
          className={styles['mapFallbackButton']}
          onClick={() => { this.setState({ error: undefined }) }}
        >
          {t('map.crashRetry')}
        </button>
      </div>
    )
  }
}
