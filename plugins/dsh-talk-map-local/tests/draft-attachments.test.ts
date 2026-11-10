import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptContent, classifyDraftFile, collectClipboardFiles, collectDropIntake, draftImageMediaType, draftSendDisabled, draftSendable, formatAttachmentBytes, hasAttachmentDrag } from '../src/client/draft-attachments.ts'

function file(name: string, type = ''): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}
function transferLike(input: { items?: unknown[]; files?: File[]; types?: string[]; data?: Record<string, string> }): DataTransfer {
  const files = input.files ?? []
  return {
    items: input.items ?? [],
    files,
    types: input.types ?? (files.length > 0 ? ['Files'] : []),
    getData: (type: string) => input.data?.[type] ?? '',
  } as unknown as DataTransfer
}

test('only the four host raster types are draft images', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.equal(draftImageMediaType(type), type)
    assert.equal(classifyDraftFile(file('x', type)), 'image')
  }
  assert.equal(draftImageMediaType('image/svg+xml'), undefined)
  assert.equal(classifyDraftFile(file('x.svg', 'image/svg+xml')), 'file')
  assert.equal(classifyDraftFile(file('x.pdf', 'application/pdf')), 'file')
})

test('clipboard keeps file items in order and ignores text items', () => {
  const a = file('a.png', 'image/png')
  const b = file('b.pdf', 'application/pdf')
  const transfer = transferLike({ items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => a }], files: [a, b] })
  assert.deepEqual(collectClipboardFiles(transfer), [a, b])
  assert.deepEqual(collectClipboardFiles(null), [])
})

test('drop prefers the app-internal file over map image sources and plain files', () => {
  const internal = file('internal.png', 'image/png')
  const plain = file('plain.pdf', 'application/pdf')
  const data = { 'application/x-talk-map-image': JSON.stringify({ src: '/talk-map/images/abc.png', title: 'drawer image' }) }
  const internalDrop = collectDropIntake(transferLike({ files: [plain], types: ['Files', 'application/x-dsh-file'], data }), () => internal)
  assert.deepEqual(internalDrop, { files: [internal], imageSources: [] })
  const sourceDrop = collectDropIntake(transferLike({ files: [], types: ['application/x-talk-map-image'], data }))
  assert.deepEqual(sourceDrop, { files: [], imageSources: [{ src: '/talk-map/images/abc.png', title: 'drawer image' }] })
  const plainDrop = collectDropIntake(transferLike({ files: [plain] }))
  assert.deepEqual(plainDrop, { files: [plain], imageSources: [] })
})

test('prompt content is receipts first, text last, omitted when empty', () => {
  assert.deepEqual(buildPromptContent(['r1', 'r2'], 'hi'), [
    { type: 'file', receiptId: 'r1' },
    { type: 'file', receiptId: 'r2' },
    { type: 'text', text: 'hi' },
  ])
  assert.deepEqual(buildPromptContent(['r1'], ''), [{ type: 'file', receiptId: 'r1' }])
  assert.deepEqual(buildPromptContent([], 'hi'), [{ type: 'text', text: 'hi' }])
})

test('fork full may send an empty first message; other modes need payload', () => {
  const base = {
    busy: false,
    needsNewWorkspaceName: false,
    isFork: true,
    mode: 'full' as const,
    generatingSummary: false,
    summaryEmpty: true,
    text: '',
    attachmentCount: 0,
  }
  assert.equal(draftSendDisabled(base), false)
  assert.equal(draftSendDisabled({ ...base, mode: 'digest' }), true)
  assert.equal(draftSendDisabled({ ...base, mode: 'digest', summaryEmpty: false }), true)
  assert.equal(draftSendDisabled({ ...base, mode: 'digest', summaryEmpty: false, attachmentCount: 1 }), false)
  assert.equal(draftSendDisabled({ ...base, mode: 'digest', generatingSummary: true, summaryEmpty: false, text: 'x' }), true)
  assert.equal(draftSendDisabled({ ...base, mode: 'none' }), true)
  assert.equal(draftSendDisabled({ ...base, mode: 'none', text: 'x' }), false)
  assert.equal(draftSendDisabled({ ...base, mode: 'none', attachmentCount: 1 }), false)
  assert.equal(draftSendDisabled({ ...base, isFork: false }), true)
  assert.equal(draftSendDisabled({ ...base, isFork: false, attachmentCount: 1 }), false)
  assert.equal(draftSendDisabled({ ...base, busy: true }), true)
  assert.equal(draftSendDisabled({ ...base, needsNewWorkspaceName: true }), true)
})

test('attachments alone are sendable', () => {
  assert.equal(draftSendable('   ', 0), false)
  assert.equal(draftSendable('hi', 0), true)
  assert.equal(draftSendable('', 2), true)
})

test('attachment byte formatting', () => {
  assert.equal(formatAttachmentBytes(0), '0 B')
  assert.equal(formatAttachmentBytes(1536), '1.5 KB')
  assert.equal(formatAttachmentBytes(5 * 1024 * 1024), '5.0 MB')
})

test('attachment drag detection', () => {
  assert.equal(hasAttachmentDrag(transferLike({ types: ['Files'] })), true)
  assert.equal(hasAttachmentDrag(transferLike({ types: ['application/x-dsh-file'] })), true)
  assert.equal(hasAttachmentDrag(transferLike({ types: ['application/x-talk-map-image'] })), true)
  assert.equal(hasAttachmentDrag(transferLike({ types: ['text/plain'] })), false)
  assert.equal(hasAttachmentDrag(null), false)
})
