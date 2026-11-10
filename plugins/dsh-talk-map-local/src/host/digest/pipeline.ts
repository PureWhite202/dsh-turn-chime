/**
 * Digest pipeline: readSurface → extract → hash-skip → one LLM call →
 * digests table.
 *
 * The model is called ONLY from the card's manual ⟳ refresh. The automatic
 * turn/end listener, the import backfill and the refresh-on-upsert trigger
 * were removed: the map must never spend model tokens on its own.
 */
import { createHash } from 'node:crypto'
import type { DigestHostServices } from '../dsh-host.ts'
import type { Digest, TalkMapStore } from '../store.ts'
import { extractFromSurface } from './extract.ts'
import { DIGEST_SYSTEM_PROMPT, digestUserPrompt, parseDigestOutput } from './prompt.ts'

const MIN_MESSAGES = 2

export class DigestPipeline {
  constructor(
    private readonly services: DigestHostServices,
    private readonly storeReady: Promise<TalkMapStore>,
    /** Fired when a digest was regenerated from CHANGED input (new
     * inputHash) — a sync fan-out can hang off this. Never fired for
     * hash-identical refreshes, so sync edges cannot flood their targets. */
    private readonly onFresh?: (sessionId: string, digest: Digest) => void,
  ) {}

  /** Manual refresh: skips the debounce, forces regeneration (ignores hash). */
  async refresh(sessionId: string): Promise<Digest> {
    return await this.run(sessionId, { force: true })
  }

  private async run(sessionId: string, options: { force: boolean }): Promise<Digest> {
    const store = await this.storeReady
    const surface = await this.services.sessionQuery.readSurface(sessionId)
    const extracted = extractFromSurface(surface.events, surface.capturedThroughSeq)
    const previous = store.digests.get(sessionId)

    if (extracted.transcript === '' || extracted.messageCount < MIN_MESSAGES) {
      // Too little to summarize — keep the previous text, no next-step.
      const digest: Digest = {
        atSeq: extracted.lastSeq,
        summary: previous?.summary ?? '',
        keyFindings: previous?.keyFindings ?? [],
        nextStep: '',
        generatedAt: Date.now(),
      }
      await store.digests.put(sessionId, digest)
      return digest
    }

    const inputHash = createHash('sha256').update(extracted.transcript).digest('hex')
    if (!options.force && previous?.inputHash === inputHash && previous.error === undefined) {
      return previous
    }

    const route = this.services.agentDefaultModel.currentSelection()
    try {
      const raw = await this.generate(route, extracted.transcript, sessionId)
      const parsed = parseDigestOutput(raw)
      const digest: Digest = {
        atSeq: extracted.lastSeq,
        summary: parsed.summary,
        keyFindings: parsed.keyFindings,
        nextStep: '',
        generatedAt: Date.now(),
        model: `${route.provider}/${route.model}`,
        inputHash,
      }
      await store.digests.put(sessionId, digest)
      if (previous?.inputHash !== inputHash) {
        // Isolated: a throwing consumer must not fall into the outer catch,
        // which would overwrite the just-persisted digest with an error one.
        try {
          this.onFresh?.(sessionId, digest)
        } catch (hookError) {
          this.services.logger?.warn(`[dsh-talk-map] onFresh hook failed: ${String(hookError)}`)
        }
      }
      return digest
    } catch (error) {
      const digest: Digest = {
        atSeq: extracted.lastSeq,
        summary: previous?.summary ?? '',
        keyFindings: previous?.keyFindings ?? [],
        nextStep: '',
        generatedAt: Date.now(),
        error: String(error).slice(0, 500),
      }
      await store.digests.put(sessionId, digest)
      return digest
    }
  }

  private async generate(
    route: { provider: string; model: string },
    transcript: string,
    sessionId: string,
  ): Promise<string> {
    const message = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: digestUserPrompt(transcript) }],
      source: { kind: 'plugin:dsh-talk-map' as const },
    }
    let text = ''
    let failure: string | undefined
    // Generous cap: reasoning models spend most of the budget thinking
    // before any text-delta arrives.
    for await (const chunk of this.services.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      system: DIGEST_SYSTEM_PROMPT,
      maxTokens: 4096,
      sessionId,
    })) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind !== 'stop') {
        failure = chunk.reason.failure?.message ?? chunk.reason.kind
      }
    }
    // A max-tokens finish with parseable text is still a usable digest;
    // parseDigestOutput throws on truncated JSON, surfacing the real failure.
    if (failure !== undefined && failure !== 'max-tokens') throw new Error(`llm finish: ${failure}`)
    if (text.trim() === '') throw new Error(`llm produced no text${failure !== undefined ? ` (${failure})` : ''}`)
    return text
  }
}
