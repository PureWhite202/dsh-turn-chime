/**
 * HTTP surface bridging the browser map to the host. Everything lives under
 * the /talk-map/ prefix — deliberately NOT /api (that prefix carries dsh's
 * browser-trust fence). Mutations accept same-origin browser requests and
 * origin-less local tools (curl); a cross-origin browser POST is refused.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import { z } from 'zod'
import type { DomainChanged, TalkMapHostServices } from './dsh-host.ts'
import type { DigestPipeline } from './digest/pipeline.ts'
import { SessionNotLiveError, type Spawner } from './spawn.ts'
import { cardSchema, edgeSchema, globalSchema, imageSchema, DOMAIN_NAME, type TalkMapStore } from './store.ts'

/**
 * Capabilities filled in by independently-injected layers: the digest layer
 * needs llm + sessionQuery, the spawn layer needs agents. Either can be
 * missing in an unusual composition — routes answer 503 rather than the
 * whole plugin refusing to mount.
 */
export interface TalkMapRuntime {
  digest?: DigestPipeline
  spawner?: Spawner
  /** Deployment default model route (from ctx.agentDefaultModel). */
  modelDefault?: () => { provider: string; model: string; reasoningEffort?: string }
  /** Deployment default agent preset id (from ctx.agentPresets). */
  presetDefault?: () => string
  /** Archive one Session through the host workspace registry (map card menu).
   *  Absent when the composition has no workspace registry → route answers 503. */
  archiveSession?: (sessionId: string) => Promise<void>
  /** Restore an archived Session — the undo behind 「已归档 · 取消」. */
  unarchiveSession?: (sessionId: string) => Promise<void>
}

const MAX_BODY_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** Raster images the map can display (SVG included for screenshots/icons). */
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}
const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

/** Content-addressed image files live beside the map store. */
function imagesDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'talk-map-images')
}

async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true // curl / same-machine tooling
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}

function tableToRecord<V>(table: { entries(): IterableIterator<[string, V]> }): Record<string, V> {
  const out: Record<string, V> = {}
  for (const [key, value] of table.entries()) out[key] = value
  return out
}

const upsertCardsBody = z.object({
  cards: z.record(z.string(), cardSchema),
})
const upsertEdgesBody = z.object({
  edges: z.record(z.string(), edgeSchema),
})
const deleteCardsBody = z.object({
  ids: z.array(z.string()),
})
/** One Session identity for the map's archive / undo routes. */
const archiveSessionBody = z.object({
  sessionId: z.string().min(1),
})
const setGlobalBody = z.object({
  global: globalSchema,
})
const spawnBody = z.object({
  parents: z.array(z.object({
    cardId: z.string(),
    sessionId: z.string(),
    text: z.string().min(1),
  })).min(1),
  boardId: z.string(),
  x: z.number(),
  y: z.number(),
  wsOverride: z.string().optional(),
})
const refreshDigestBody = z.object({
  sessionId: z.string(),
})
const injectBody = z.object({
  sessionId: z.string(),
  parents: z.array(z.object({
    sessionId: z.string(),
    text: z.string().min(1),
  })).min(1),
})
const ensureDirBody = z.object({
  path: z.string().min(1),
})
const upsertImagesBody = z.object({
  images: z.record(z.string(), imageSchema),
})
const deleteImagesBody = z.object({
  ids: z.array(z.string()),
})

/**
 * Register the /talk-map/ routes.
 * @param services - host services (webServer + event bus).
 * @param storeReady - resolves when the storage domain is open; handlers await it.
 * @returns disposer removing the route registration and closing SSE clients.
 */
export function mountTalkMapRoutes(
  services: TalkMapHostServices,
  storeReady: Promise<TalkMapStore>,
  runtime: TalkMapRuntime,
): () => void {
  const sseClients = new Set<ServerResponse>()

  const offChanged = services.on('domain/changed', (...args: unknown[]) => {
    const change = args[0] as DomainChanged
    if (change.domain !== DOMAIN_NAME) return
    const frame = `event: change\ndata: ${JSON.stringify(change)}\n\n`
    for (const client of sseClients) client.write(frame)
  })

  const ping = setInterval(() => {
    for (const client of sseClients) client.write(': ping\n\n')
  }, 25_000)
  ping.unref?.()

  const unregister = services.webServer.register({
    kind: 'prefix',
    // NOTE: webserver prefix p matches `p` and `p/<anything>` — no trailing slash.
    path: '/talk-map',
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const route = `${request.method ?? 'GET'} ${url.pathname}`
      try {
        if (route === 'GET /talk-map/state') {
          const store = await storeReady
          sendJson(response, 200, {
            boards: tableToRecord(store.boards),
            cards: tableToRecord(store.cards),
            edges: tableToRecord(store.edges),
            digests: tableToRecord(store.digests),
            images: tableToRecord(store.images),
            global: store.global(),
          })
          return
        }

        if (route === 'GET /talk-map/defaults') {
          let model: unknown = null
          let preset: unknown = null
          try {
            model = runtime.modelDefault?.() ?? null
          } catch { /* unresolved default model config */ }
          try {
            preset = runtime.presetDefault?.() ?? null
          } catch { /* no presets composed */ }
          sendJson(response, 200, { model, preset })
          return
        }

        if (route === 'GET /talk-map/events') {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            'connection': 'keep-alive',
          })
          response.write(': connected\n\n')
          sseClients.add(response)
          request.on('close', () => { sseClients.delete(response) })
          return
        }

        if (request.method === 'POST' && !sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin request refused' })
          return
        }

        if (route === 'POST /talk-map/cards/upsert') {
          const store = await storeReady
          const body = upsertCardsBody.parse(await readJsonBody(request))
          for (const [id, card] of Object.entries(body.cards)) {
            await store.cards.put(id, card)
          }
          sendJson(response, 200, { ok: true, count: Object.keys(body.cards).length })
          return
        }

        if (route === 'POST /talk-map/edges/upsert') {
          const store = await storeReady
          const body = upsertEdgesBody.parse(await readJsonBody(request))
          for (const [id, edge] of Object.entries(body.edges)) {
            await store.edges.put(id, edge)
          }
          sendJson(response, 200, { ok: true, count: Object.keys(body.edges).length })
          return
        }

        if (route === 'POST /talk-map/cards/delete') {
          const store = await storeReady
          const body = deleteCardsBody.parse(await readJsonBody(request))
          let removed = 0
          for (const id of body.ids) {
            if (await store.cards.delete(id)) removed += 1
          }
          // A card's edges die with it — a dangling edge renders nothing anyway.
          for (const [edgeId, edge] of [...store.edges.entries()]) {
            if (body.ids.includes(edge.fromCardId) || body.ids.includes(edge.toCardId)) {
              await store.edges.delete(edgeId)
            }
          }
          sendJson(response, 200, { ok: true, removed })
          return
        }

        if (route === 'POST /talk-map/images/upsert') {
          const store = await storeReady
          const body = upsertImagesBody.parse(await readJsonBody(request))
          for (const [id, image] of Object.entries(body.images)) {
            await store.images.put(id, image)
          }
          sendJson(response, 200, { ok: true, count: Object.keys(body.images).length })
          return
        }

        if (route === 'POST /talk-map/images/delete') {
          const store = await storeReady
          const body = deleteImagesBody.parse(await readJsonBody(request))
          let removed = 0
          for (const id of body.ids) {
            if (await store.images.delete(id)) removed += 1
          }
          sendJson(response, 200, { ok: true, removed })
          return
        }

        if (route === 'POST /talk-map/images/upload') {
          const mime = String(request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''
          const ext = IMAGE_MIME_EXT[mime]
          if (ext === undefined) {
            sendJson(response, 415, { error: 'unsupported image type' })
            return
          }
          let bytes: Buffer
          try {
            bytes = await readRawBody(request, MAX_IMAGE_BYTES)
          } catch {
            sendJson(response, 413, { error: 'image too large' })
            return
          }
          if (bytes.length === 0) {
            sendJson(response, 400, { error: 'empty image' })
            return
          }
          const sha = createHash('sha256').update(bytes).digest('hex')
          const dir = imagesDir()
          await mkdir(dir, { recursive: true })
          const file = join(dir, `${sha}.${ext}`)
          try {
            await readFile(file)
          } catch {
            await writeFile(file, bytes)
          }
          sendJson(response, 200, { src: `/talk-map/images/${sha}.${ext}`, size: bytes.length })
          return
        }

        const imageMatch = url.pathname.match(/^\/talk-map\/images\/([a-f0-9]{64})\.(png|jpg|gif|webp|svg)$/)
        if (request.method === 'GET' && imageMatch !== null) {
          try {
            const bytes = await readFile(join(imagesDir(), `${imageMatch[1]}.${imageMatch[2]}`))
            response.writeHead(200, {
              'content-type': IMAGE_EXT_MIME[imageMatch[2] ?? ''] ?? 'application/octet-stream',
              'cache-control': 'public, max-age=31536000, immutable',
              'content-length': bytes.length,
            })
            response.end(bytes)
          } catch {
            sendJson(response, 404, { error: 'image not found' })
          }
          return
        }

        if (route === 'POST /talk-map/edges/delete') {
          const store = await storeReady
          const body = deleteCardsBody.parse(await readJsonBody(request))
          let removed = 0
          for (const id of body.ids) {
            if (await store.edges.delete(id)) removed += 1
          }
          sendJson(response, 200, { ok: true, removed })
          return
        }

        if (route === 'POST /talk-map/global') {
          const store = await storeReady
          const body = setGlobalBody.parse(await readJsonBody(request))
          await store.setGlobal(body.global)
          sendJson(response, 200, { ok: true })
          return
        }

        if (route === 'POST /talk-map/inject') {
          if (runtime.spawner === undefined) {
            sendJson(response, 503, { error: 'spawn layer unavailable (agents service missing)' })
            return
          }
          const body = injectBody.parse(await readJsonBody(request))
          try {
            runtime.spawner.injectInto(body.sessionId, body.parents)
          } catch (error) {
            // Structured code — clients branch on it instead of substring-
            // matching a quadruple-stringified error message.
            if (error instanceof SessionNotLiveError) {
              sendJson(response, 409, { error: String(error), code: 'session-not-live' })
              return
            }
            throw error
          }
          sendJson(response, 200, { ok: true })
          return
        }

        if (route === 'POST /talk-map/spawn') {
          if (runtime.spawner === undefined) {
            sendJson(response, 503, { error: 'spawn layer unavailable (agents service missing)' })
            return
          }
          const body = spawnBody.parse(await readJsonBody(request))
          const result = await runtime.spawner.spawn(body)
          sendJson(response, 200, result)
          return
        }

        if (route === 'POST /talk-map/fs/ensure-dir') {
          // dsh's workspace.create only REGISTERS an existing directory
          // (realpath fails on a missing one) — the draft composer's
          // "new workspace" flow creates the folder here first.
          const body = ensureDirBody.parse(await readJsonBody(request))
          const target = resolvePath(body.path)
          const home = homedir()
          if (target !== home && !target.startsWith(home + sep)) {
            sendJson(response, 400, { error: 'path must be inside the home directory' })
            return
          }
          await mkdir(target, { recursive: true })
          sendJson(response, 200, { ok: true, path: target })
          return
        }

        if (route === 'POST /talk-map/archive') {
          if (runtime.archiveSession === undefined) {
            sendJson(response, 503, { error: 'workspace registry unavailable' })
            return
          }
          const body = archiveSessionBody.parse(await readJsonBody(request))
          await runtime.archiveSession(body.sessionId)
          sendJson(response, 200, { ok: true, sessionId: body.sessionId })
          return
        }

        if (route === 'POST /talk-map/unarchive') {
          if (runtime.unarchiveSession === undefined) {
            sendJson(response, 503, { error: 'workspace registry unavailable' })
            return
          }
          const body = archiveSessionBody.parse(await readJsonBody(request))
          await runtime.unarchiveSession(body.sessionId)
          sendJson(response, 200, { ok: true, sessionId: body.sessionId })
          return
        }

        if (route === 'POST /talk-map/digest/refresh') {
          if (runtime.digest === undefined) {
            sendJson(response, 503, { error: 'digest layer unavailable (llm service missing)' })
            return
          }
          const body = refreshDigestBody.parse(await readJsonBody(request))
          const digest = await runtime.digest.refresh(body.sessionId)
          sendJson(response, 200, { sessionId: body.sessionId, digest })
          return
        }

        sendJson(response, 404, { error: `no such route: ${route}` })
      } catch (error) {
        services.logger?.warn(`[dsh-talk-map] ${route} failed: ${String(error)}`)
        if (!response.headersSent) {
          sendJson(response, 400, { error: String(error) })
        } else {
          response.end()
        }
      }
    },
  })

  return () => {
    clearInterval(ping)
    offChanged()
    for (const client of sseClients) client.end()
    sseClients.clear()
    unregister()
  }
}
