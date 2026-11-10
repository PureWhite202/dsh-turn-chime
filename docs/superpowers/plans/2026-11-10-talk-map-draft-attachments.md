# 对话地图草稿卡附件支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让对话地图「新对话」草稿卡支持粘贴/拖入图片与普通文件，并在发送时把附件随第一条消息一起投递。

**Architecture:** 附件先只存在浏览器内（`File` + object URL 预览）；点发送后按现有流程创建/分叉会话，再用 dsh 官方 `ctx.fileUpload` 按添加顺序上传（图片 `uploadImage`、文件 `upload`），把返回的 `receiptId` 拼成 `file` part，最后与文字一起走同一条 `session.prompt`。草稿卡是唯一接管 drop 的表面，drop 必须 `stopPropagation`。

**Tech Stack:** TypeScript、React 18、@xyflow/react、tsdown、Node 24 内置测试、Playwright（隔离 E2E）。

**Spec:** `docs/superpowers/specs/2026-11-10-talk-map-draft-attachments-design.md`

## Global Constraints

- 部署基线：DeepSeek Harness 0.2.2-rc.1，macOS 桌面版，profile=`desktop`；插件版本 0.1.5 → 0.1.6。
- 不新增运行时依赖；client bundle 只允许 react / react-dom 作为外部模块，其余全部内联。
- 不 `import` 任何 `@deepseek-ai/*` 运行时模块；只写结构化类型（现有 `src/client/dsh.ts` 风格）。
- 所有新增界面文案必须中英双语（`src/client/i18n.ts` 的 zh + en 两套）。
- prompt 内容顺序固定：附件 receipt parts 在前，文字 part 最后；文字为空时不追加。
- 只在草稿卡内接管 drop；`drop` 处理器必须 `preventDefault()` + `stopPropagation()`。
- 不在客户端硬编码 host 的图片数量/字节上限；host 拒绝时显示 host 错误。
- 每次提交只 add 本计划涉及的文件；仓库里 dsh-purewhite-toolkit 的既有改动不要带上。

## Review Focus

- **粘贴「文字 + 图片」同时发生时**：图片要进附件栏，同时文字仍应进入 textarea，不能因为 preventDefault 吞掉文字。
- **从右侧抽屉会话把图片拖到草稿卡**：应变成草稿附件，而不是在白板上新建图片节点。
- **host 拒绝图片时**（例如字节与声明的 mediaType 不符）：草稿与附件必须保留、显示错误、不能悄悄发出半条消息。
- **上传过程中关闭草稿（Esc）**：上传应中止，页面不出现未处理异常，也不残留 busy 状态。
- **只发附件不发文字**：发送按钮必须可用，并成功产生一条只带附件的消息。

---

### Task 1: 附件纯函数 + 单元测试 + 基线

**Files:**
- Create: `src/client/draft-attachments.ts`
- Create: `tests/draft-attachments.test.ts`
- Modify: `package.json`（version → `0.1.6`；scripts.test）
- Modify: `tsconfig.json`（include 增加 `tests`）

**Interfaces:**
- Produces（Task 3/5 使用）：
  - `type DraftImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'`
  - `interface DraftAttachment { id: string; kind: 'image' | 'file'; file: File; previewUrl?: string; mediaType?: DraftImageMediaType }`
  - `function draftImageMediaType(value: string): DraftImageMediaType | undefined`
  - `function classifyDraftFile(file: File): 'image' | 'file'`
  - `function collectClipboardFiles(transfer: DataTransfer | null): File[]`
  - `interface DropIntake { files: File[]; imageSources: { src: string; title?: string }[] }`
  - `function collectDropIntake(transfer: DataTransfer, readAppFile?: (transfer: DataTransfer) => File | undefined): DropIntake`
  - `function hasAttachmentDrag(transfer: DataTransfer | null): boolean`
  - `function buildPromptContent(receiptIds: readonly string[], text: string): ({ type: 'file'; receiptId: string } | { type: 'text'; text: string })[]`
  - `function draftSendable(text: string, attachmentCount: number): boolean`
  - `function formatAttachmentBytes(bytes: number): string`

- [ ] **Step 1: 安装依赖并确认基线可构建**

Run:
```bash
cd ~/.dsh/my-dsh/plugins/dsh-talk-map-local
pnpm install --offline
pnpm run typecheck && pnpm run build
```
Expected: install 成功（离线缓存已有 0.1.5 的依赖）；typecheck 与 build 均 exit 0，生成 `lib/index.js`、`client/client.js`。若 `--offline` 失败，去掉 `--offline` 重跑并记录。

- [ ] **Step 2: 版本与测试脚本**

`package.json`：`"version": "0.1.6"`，新增 `"test": "node --test tests/*.test.ts"`。
`tsconfig.json`：`"include": ["src", "tests", "tsdown.config.ts"]`。

- [ ] **Step 3: 写失败的测试**

`tests/draft-attachments.test.ts`：
```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptContent, classifyDraftFile, collectClipboardFiles, collectDropIntake, draftImageMediaType, draftSendable, formatAttachmentBytes, hasAttachmentDrag } from '../src/client/draft-attachments.ts'

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
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../src/client/draft-attachments.ts'`（或等价解析错误）。

- [ ] **Step 5: 实现 `src/client/draft-attachments.ts`**

实现上述 Interfaces；关键行为：

- `draftImageMediaType`：只把 `image/png|jpeg|webp|gif` 原样返回，其余 `undefined`。
- `collectClipboardFiles`：先遍历 `transfer.items` 取 `kind === 'file'` 的 `getAsFile()`，再补 `Array.from(transfer.files)` 中尚未出现的项；返回源顺序，按对象身份去重。
- `collectDropIntake`：`readAppFile(transfer)` 有值 → `{ files: [file], imageSources: [] }`；否则解析 `getData('application/x-talk-map-image')`（JSON，失败则忽略）得到 `{src,title?}` → 有 source 时 `{ files: [], imageSources: [source] }`；否则 `{ files: Array.from(transfer.files), imageSources: [] }`。
- `hasAttachmentDrag`：`types` 包含 `Files`、`application/x-dsh-file`、`application/x-talk-map-image` 任一。
- `buildPromptContent`：先按顺序生成 `{ type:'file', receiptId }`，再在 `text !== ''` 时追加 `{ type:'text', text }`。
- `draftSendable`：`text.trim() !== '' || attachmentCount > 0`。
- `formatAttachmentBytes`：`< 1024` → `N B`；`< 1MiB` → `(n/1024).toFixed(1) KB`；否则 `(n/1048576).toFixed(1) MB`。
- 本任务不依赖 `dsh.ts`：返回类型直接写 `{ type: 'file'; receiptId: string } | { type: 'text'; text: string }`，Task 2 的 `PromptContentPart` 是其超集。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS，7 个测试全绿。

- [ ] **Step 7: 提交**

```bash
cd ~/.dsh/my-dsh
git add plugins/dsh-talk-map-local/package.json plugins/dsh-talk-map-local/tsconfig.json plugins/dsh-talk-map-local/src/client/draft-attachments.ts plugins/dsh-talk-map-local/tests/draft-attachments.test.ts
git commit -m "插件：对话地图草稿卡附件纯函数与单测"
```

---

### Task 2: DSH 客户端契约与服务注入

**Files:**
- Modify: `src/client/dsh.ts`
- Modify: `src/client/map-state.ts`
- Modify: `src/client/index.ts`

**Interfaces:**
- Produces（Task 3/5 使用）：
  - `type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'`
  - `type PromptContentPart = { type: 'text'; text: string } | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string } | { type: 'file'; receiptId: string }`
  - `interface FileUploadProgress { loaded: number; total?: number }`
  - `interface FileUploadReceipt { receiptId: string }`
  - `interface FileUploadService { upload(sessionId: string, data: Blob, name?: string, signal?: AbortSignal, onProgress?: (p: FileUploadProgress) => void): Promise<RemoteResult<FileUploadReceipt>>; uploadImage(sessionId: string, data: Blob, mediaType: ImageMediaType, name?: string, signal?: AbortSignal, onProgress?: (p: FileUploadProgress) => void): Promise<RemoteResult<FileUploadReceipt>> }`
  - `interface FileDragService { read(transfer: DataTransfer): File | undefined }`
  - `MapServices` 新增 `fileUpload: FileUploadService`、`fileDrag: FileDragService`
  - `TalkMapClientContext` 新增 `fileUpload`、`fileDrag`

- [ ] **Step 1: 扩展 `src/client/dsh.ts`**

- 在 `SessionSummary` 附近加 `ImageMediaType`、`PromptContentPart`。
- 把 `RemoteService.session.prompt` 的 `content` 从 `{ type: 'text'; text: string }[]` 改成 `PromptContentPart[]`。
- 新增 `FileUploadProgress`、`FileUploadReceipt`、`FileUploadService`、`FileDragService`。
- `TalkMapClientContext` 增加 `fileUpload: FileUploadService`、`fileDrag: FileDragService`（写注释说明来自 dsh 官方 file-upload / ui-file-drag 客户端服务）。

- [ ] **Step 2: `src/client/map-state.ts`**

`MapServices` 增加 `fileUpload`、`fileDrag` 两个必填字段；`import type` 更新。`attachServices` 不需要逻辑变化（调用方负责传入完整对象）。

- [ ] **Step 3: `src/client/index.ts`**

- `inject` 数组追加 `'fileUpload'`、`'fileDrag'`。
- `attachServices({...})` 增加 `fileUpload: ctx.fileUpload, fileDrag: ctx.fileDrag`。

- [ ] **Step 4: 类型检查**

Run: `pnpm run typecheck`
Expected: PASS（若 Task 1 的 `PromptContentPart` 引用报错，检查 `import type` 与命名一致性）。

- [ ] **Step 5: 提交**

```bash
cd ~/.dsh/my-dsh
git add plugins/dsh-talk-map-local/src/client/dsh.ts plugins/dsh-talk-map-local/src/client/map-state.ts plugins/dsh-talk-map-local/src/client/index.ts
git commit -m "插件：对话地图接入 dsh fileUpload/fileDrag 契约"
```

---

### Task 3: DraftCard 附件收集与预览 UI

**Files:**
- Modify: `src/client/DraftCard.tsx`
- Modify: `src/client/i18n.ts`
- Modify: `src/client/talk-map.module.css`

**Interfaces:**
- Consumes: Task 1 helpers；Task 2 的 `fileDrag`（`getServices()?.fileDrag`）。
- Produces（Task 4 E2E 的稳定选择器）：
  - 草稿卡根节点 `data-talk-map-draft=""`
  - 每个附件项 `data-talk-map-attachment={kind}`（`image` / `file`）
  - 拖拽悬停态 `data-talk-map-drop-active="1"`（仅悬停时）
  - 附件栏容器 `data-talk-map-attachments=""`

- [ ] **Step 1: i18n 文案**

`src/client/i18n.ts` zh 增加：
```ts
'draft.placeholder': '想聊什么？可粘贴/拖入图片或文件；回车发送，Shift+回车换行',
'draft.dropHint': '松开以添加图片或文件',
'draft.removeAttachment': '移除附件',
'draft.uploading': '上传中 {done}/{total}…',
'draft.uploadFailed': '附件上传失败：',
'draft.attachFailed': '添加附件失败：',
'draft.untitledFile': '未命名文件',
```
en 增加对应英文（保持现有键序）。

- [ ] **Step 2: 附件状态与收集**

`DraftCard` 内：
- `const [attachments, setAttachments] = useState<DraftAttachment[]>([])`
- `const [dragActive, setDragActive] = useState(false)`
- `const [error, setError]` 复用现有错误状态显示附件错误。
- `addFiles(files: File[])`：对每个文件用 `classifyDraftFile`；图片生成 `URL.createObjectURL(file)` 预览；id 用 `crypto.randomUUID()`；append 到现有顺序；空数组直接返回。
- `removeAttachment(id)`：revoke object URL，过滤。
- 卸载 effect：revoke 所有现存附件的 object URL。
- 图片扩展名/名称仅用于展示，不做类型改写。

- [ ] **Step 3: 粘贴与拖入处理器**

- textarea `onPaste`：
  ```ts
  const files = collectClipboardFiles(event.clipboardData)
  if (files.length === 0) return
  event.preventDefault()
  addFiles(files)
  ```
  注意：如果剪贴板同时有 `text/plain`，不要 preventDefault，让 textarea 默认插入文字；只在 `getData('text/plain') === ''` 时 preventDefault 并返回。
- 草稿卡根 `onDragEnter/onDragOver`：`hasAttachmentDrag` 为 true 时 `preventDefault()`、`dropEffect = 'copy'`、`setDragActive(true)`；不 stopPropagation（让 dsh 的全屏拖放提示层正常工作）。
- 根 `onDragLeave`：`relatedTarget` 不在卡内时 `setDragActive(false)`。
- 根 `onDrop`：只要 `hasAttachmentDrag(event.dataTransfer)` 为 true 就 `preventDefault()` + `stopPropagation()`（避免浏览器把 drop 当成导航或落到背后 composer），然后再处理：
  ```ts
  const intake = collectDropIntake(event.dataTransfer, getServices()?.fileDrag?.read.bind(getServices()!.fileDrag))
  if (intake.files.length === 0 && intake.imageSources.length === 0) return
  event.preventDefault(); event.stopPropagation(); setDragActive(false)
  // 先落地 files；imageSources 逐个 fetch(src) → blob → new File([blob], name, { type: blob.type || guess })
  ```
  `imageSources` 的 name 取 `title`，否则 URL 最后一段；`fetch` 失败时把错误写进 `error`（用 `String(error)`，前缀 `t('draft.attachFailed')`）。`application/x-dsh-file` token 由 `fileDrag.read` 解析；非 File 返回值忽略。

- [ ] **Step 4: 渲染附件栏**

在 textarea 之前插入（仅 `attachments.length > 0`）：
- 容器 `className={`${styles['draftAttachments']} nodrag`}` + `data-talk-map-attachments`。
- 图片项：`<img src={previewUrl} alt={file.name} />` + 移除按钮（`aria-label={t('draft.removeAttachment')}`）。
- 文件项：文档图标（inline SVG）、`file.name || t('draft.untitledFile')`、`formatAttachmentBytes(file.size)`、移除按钮。
- 拖动悬停时卡片根加 `styles['draftCardDrop']` 与 `data-talk-map-drop-active`，并在附件栏上方显示 `t('draft.dropHint')`。
- 所有附件项加 `nodrag`，移除按钮加 `nodrag`。

- [ ] **Step 5: CSS**

`talk-map.module.css` 增加：
- `.draftAttachments`：横向 flex、gap 8、overflow-x auto、padding 2px、max-height 72px。
- `.draftAttachmentImage`：64×64、相对定位、圆角、overflow hidden、边框。
- `.draftAttachmentImage img`：100% cover。
- `.draftAttachmentFile`：高 64、宽 180、flex 列/行、边框、圆角、padding、文件名 ellipsis。
- `.draftAttachmentRemove`：绝对定位右上角小圆按钮，hover/focus 可见。
- `.draftAttachmentProgress`：底部 2px 进度条（Task 5 使用，可先定义）。
- `.draftCardDrop`：`border-color: var(--dsw-alias-brand-primary)` + 轻微背景高亮。
- `.draftDropHint`：小字提示，`color: var(--dsw-alias-brand-primary)`。

- [ ] **Step 6: 类型检查与构建**

Run: `pnpm run typecheck && pnpm run build`
Expected: 均 exit 0；`client/client.js` 大小增长，包含 `draft.dropHint` 字面量。

- [ ] **Step 7: 提交**

```bash
cd ~/.dsh/my-dsh
git add plugins/dsh-talk-map-local/src/client/DraftCard.tsx plugins/dsh-talk-map-local/src/client/i18n.ts plugins/dsh-talk-map-local/src/client/talk-map.module.css plugins/dsh-talk-map-local/client/client.js plugins/dsh-talk-map-local/client/client.js.map
git commit -m "插件：对话地图草稿卡支持粘贴与拖入附件"
```

---

### Task 4: 隔离 E2E 夹具 + 附件接收验证

**Files:**
- Create: `tests/e2e/draft-attachments.e2e.mjs`
- Create: `tests/e2e/README.md`（如何运行）
- Modify: `package.json`（`e2e` script 可选）

**Interfaces:**
- Consumes: Task 3 的 `data-talk-map-draft` / `data-talk-map-attachments` / `data-talk-map-attachment` 选择器；本地已安装的 `playwright`（绝对路径导入）。
- Produces（Task 5 复用）：`openDraft(page)`、`pasteFiles(page, files)`、`dropFiles(page, files, data)`、`attachmentCount(page)`。

- [ ] **Step 1: 写夹具骨架**

`tests/e2e/draft-attachments.e2e.mjs` 顺序：
1. `pnpm run build && pnpm pack --ignore-scripts`（cwd=插件目录）；记录 tgz 路径。
2. 创建临时 `DSH_HOME`（`fs.mkdtemp(os.tmpdir()+'/talk-map-e2e-')`）。
3. `DSH_HOME=<tmp> dsh plugin --profile e2e add file:<tgz 绝对路径>`。
4. 读 `<tmp>/profiles/e2e/package.json`，把 `dsh.profile.bundles` 设为 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-talk-map-local']`。
5. 复制 `~/.dsh/.credentials.yaml` → `<tmp>/.credentials.yaml`（只为本地测试跳过 Get started 弹窗；不写进仓库、不打印内容）。
6. 启动 `DSH_HOME=<tmp> dsh --profile e2e --port 0 --no-open --host 127.0.0.1`；从 stdout 解析 `http://127.0.0.1:<port>/?token=...`。
7. `chromium.launch({ headless: true })`，`page.goto(tokenUrl)`。
8. 等侧栏「Talk Map」按钮出现（英文 locale 下 `getByRole('button', { name: 'Talk Map' })`），点击。
9. `page.locator('[data-talk-map-canvas]').dblclick({ position: { x: 500, y: 300 } })`，等 `[data-talk-map-draft]`。
10. 每个场景后 `process.exitCode = 1` 并打印失败断言；结束时 `host.kill('SIGTERM')`，删除临时 home（保留失败截图到 `tests/e2e/artifacts/`，该目录 gitignore）。

`README.md` 写运行命令与前置条件（Node 24、pnpm、全局 playwright、~/.dsh/.credentials.yaml 存在）。

- [ ] **Step 2: 场景 A — 粘贴图片**

用 `page.evaluate` 在 textarea 上构造 `DataTransfer` + `ClipboardEvent('paste', { clipboardData: dt })`，文件为 1×1 PNG（base64 常量）。断言：
- `[data-talk-map-attachment="image"]` 数量 = 1
- 同节点内 `img[src^="blob:"]` 存在
- 发送按钮仍可用（图片存在时）。

- [ ] **Step 3: 场景 B — 粘贴文字 + 图片**

同一事件携带 `text/plain` 文本（例如 `hello image`）和图片文件。断言：
- 附件数 = 1
- `textarea.value` 包含 `hello image`

- [ ] **Step 4: 场景 C — 拖入普通文件**

构造 `DragEvent('drop', { dataTransfer: dt })`，dt 里放 `report.pdf`（`application/pdf`，内容为任意字节）。在草稿卡根节点 dispatch。断言：
- `[data-talk-map-attachment="file"]` 数量 = 1，文本包含 `report.pdf`
- 画布图片节点数量不变（`page.locator('.react-flow__node-imageNode').count()` 前后一致）

- [ ] **Step 5: 场景 D — 模拟抽屉拖出的图片**

`dt.setData('application/x-talk-map-image', JSON.stringify({ src: '<一个可 fetch 的本地图片地址>', title: 'drawer' }))`；src 用已上传到 talk-map 图片路由的 URL（可先 `fetch('/talk-map/images/upload', {method:'POST', body: pngBlob})` 拿到 `src`）。断言：
- 草稿附件数 = 1
- 画布图片节点数量不变
- 不出现 `error` 文本

- [ ] **Step 6: 场景 E — 移除附件**

点击 `[data-talk-map-attachment]` 内的移除按钮。断言附件数 = 0。

- [ ] **Step 7: 运行并修复**

Run: `node tests/e2e/draft-attachments.e2e.mjs`
Expected: 全部场景 PASS，进程 exit 0。
若 0.2.2-rc.1 的 UI 文案不是英文（首次加载可能是中文），把选择器改为同时匹配 `Talk Map|对话地图`，并在 README 记录。

- [ ] **Step 8: 提交**

```bash
cd ~/.dsh/my-dsh
git add plugins/dsh-talk-map-local/tests/e2e/draft-attachments.e2e.mjs plugins/dsh-talk-map-local/tests/e2e/README.md
git commit -m "插件：对话地图草稿卡附件隔离 E2E 夹具"
```

---

### Task 5: 发送时上传 + 完整 E2E

**Files:**
- Modify: `src/client/DraftCard.tsx`
- Modify: `tests/e2e/draft-attachments.e2e.mjs`
- Modify: `src/client/talk-map.module.css`（进度条/上传文案）

**Interfaces:**
- Consumes: Task 1 `buildPromptContent`/`draftSendable`；Task 2 `fileUpload`；Task 3 附件状态。
- Produces: 无（内部实现）。

- [ ] **Step 1: 上传与发送**

在 `DraftCard` 内新增：
```ts
const uploadAttachments = async (remote: RemoteService, sessionId: string, signal: AbortSignal): Promise<string[]> => {
  const receiptIds: string[] = []
  for (const [index, attachment] of attachments.entries()) {
    setUploadNote(t('draft.uploading', { done: String(index + 1), total: String(attachments.length) }))
    const onProgress = (p: FileUploadProgress): void => setUploadProgress(prev => ({ ...prev, [attachment.id]: p.total !== undefined && p.total > 0 ? p.loaded / p.total : 0 }))
    const call = attachment.kind === 'image' && attachment.mediaType !== undefined
      ? getServices()!.fileUpload.uploadImage(sessionId, attachment.file, attachment.mediaType, attachment.file.name, signal, onProgress)
      : getServices()!.fileUpload.upload(sessionId, attachment.file, attachment.file.name, signal, onProgress)
    const value = unwrapRemote<FileUploadReceipt>(await call, 'fileUpload')
    receiptIds.push(value.receiptId)
  }
  setUploadNote(undefined)
  setUploadProgress({})
  return receiptIds
}
```
约束：
- `attachments` 为空时直接返回 `[]`，不发上传请求。
- `send()` 开头创建 `AbortController` 存 ref；组件卸载时 abort。
- 附件上传必须在会话创建之后、`selectModel`/prompt 之前。
- 每个分支（plain / fork full / fork digest / fork none）都改为：
  1) 创建会话或 fork；2) `await uploadAttachments(...)` 得到 receiptIds；3) `selectModel`；4) `await sendPrompt(remote, sessionId, text, receiptIds)`（当 `receiptIds.length > 0 || text !== ''`）；5) `addDraftCard`/`addForkEdge`/`ensureFrame`（上传失败时不落卡片）；6) `finish`。
- `sendPrompt` 改为：
  ```ts
  const content = buildPromptContent(receiptIds, text)
  ```
  `sendPrompt` 签名固定为 `sendPrompt(remote, sessionId, text: string, receiptIds: readonly string[])`。
- `sendDisabled` 改为 `busy || needsNewWorkspaceName || (isFork ? (mode === 'digest' && (generatingSummary || summary.trim() === '')) : false) || !draftSendable(text, attachments.length)`；fork 的 digest 模式额外要求摘要非空。
- `busy` 时按钮文案：有上传进行中显示 `uploadNote`，否则现有 `draft.sending`/`spawn.busy`。
- 失败处理：`catch (sendError)` 时若 `controller.signal.aborted` 直接 return；否则 `setError(String(sendError))`、`setBusy(false)`、清 `uploadNote`。

- [ ] **Step 2: 进度 UI**

- 图片附件：`uploadProgress[id]` 存在时在缩略图底部渲染 `.draftAttachmentProgress` 内条（width = `Math.round(ratio*100)%`）。
- 文件附件：同样在卡片底部显示 2px 进度条。
- 发送按钮仍禁用（busy）。

- [ ] **Step 3: 扩展 E2E — 发送图片**

在场景 A 后：点「Send」，等 `[data-talk-map-draft]` 消失（timeout 20s），等地图出现一张会话卡（`.react-flow__node-sessionCard` 数量 ≥ 1），等右侧抽屉 `aside` 出现，并断言抽屉内 `img` 数量 ≥ 1（消息回显）。若模型/网络失败导致 echo 延迟，只断言卡片出现 + 抽屉打开，并在 README 注明。

- [ ] **Step 4: 扩展 E2E — 只发文件**

新建草稿（双击空白），拖入 `report.pdf`，不输入文字，断言发送按钮 enabled；点 Send；断言草稿消失、会话卡出现、抽屉打开。

- [ ] **Step 5: 扩展 E2E — host 拒绝图片**

粘贴一个 `type: 'image/png'` 但内容为 `not an image` 的 File；点 Send；等错误行出现（文本包含 `Upload`/`attachment`/`图片` 任一关键字，或节点仍在）；断言草稿仍存在、会话卡数量不增加。截图到 artifacts。

- [ ] **Step 6: 扩展 E2E — Esc 中止上传**

拖入一个 20MB 的随机文件；点 Send 后 100ms 按 `Escape`；等 500ms；断言 `pageerror` 事件为 0、草稿消失、无挂起遮罩。若本地 host 上传完成太快导致 Esc 来不及，放宽为「无 pageerror 且最终状态稳定」并在 README 注明。

- [ ] **Step 7: 运行 E2E**

Run: `node tests/e2e/draft-attachments.e2e.mjs`
Expected: 所有场景 PASS，exit 0；完成后临时 host 已停止、临时 home 已删除。

- [ ] **Step 8: 提交**

```bash
cd ~/.dsh/my-dsh
git add plugins/dsh-talk-map-local/src/client/DraftCard.tsx plugins/dsh-talk-map-local/src/client/talk-map.module.css plugins/dsh-talk-map-local/client/client.js plugins/dsh-talk-map-local/client/client.js.map plugins/dsh-talk-map-local/tests/e2e/draft-attachments.e2e.mjs
git commit -m "插件：对话地图草稿卡发送时上传附件"
```

---

### Task 6: 打包、安装到 desktop profile、交付

**Files:**
- Modify: `src/client/*`（仅修复 Task 5 E2E 暴露的问题）
- Build artifacts: `client/client.js`、`client/client.js.map`、`lib/index.js`
- Deliverable: `dsh-talk-map-local-0.1.6.tgz`（被 gitignore）

- [ ] **Step 1: 全量验证**

Run:
```bash
cd ~/.dsh/my-dsh/plugins/dsh-talk-map-local
pnpm run typecheck && pnpm test && pnpm run build
node tests/e2e/draft-attachments.e2e.mjs
```
Expected: 全部 exit 0。

- [ ] **Step 2: 打包**

Run: `pnpm pack --ignore-scripts`
Expected: 生成 `dsh-talk-map-local-0.1.6.tgz`；`tar -tzf` 包含 `client/client.js`、`lib/index.js`、`src/`。

- [ ] **Step 3: 安装到 desktop profile**

用 `plugin_manager` 工具（desktop profile 被 Electron 独占，禁止 `dsh plugin --profile desktop`）：
1. `list_bundles` 找到 `dsh-talk-map-local` 的当前状态；
2. `remove_bundle target="dsh-talk-map-local"`；
3. `install_bundle target="file:/Users/chunbailaiyin/.dsh/my-dsh/plugins/dsh-talk-map-local/dsh-talk-map-local-0.1.6.tgz"`。
若 `remove_bundle` 因运行中不可移除而失败：改为 `install_bundle` 直接覆盖并接受 `restart-required`；仍失败时，把构建产物复制到 `~/.dsh/profiles/desktop/node_modules/dsh-talk-map-local/{client,lib,src,package.json}` 作为兜底，并明确告知用户这是本地覆盖。

- [ ] **Step 4: 验证安装**

Run:
```bash
cat ~/.dsh/profiles/desktop/node_modules/dsh-talk-map-local/package.json | grep '"version"'
grep -c "draft.uploading" ~/.dsh/profiles/desktop/node_modules/dsh-talk-map-local/client/client.js
```
Expected: `0.1.6`；grep 计数 ≥ 1。

- [ ] **Step 5: 提交代码与文档**

```bash
cd ~/.dsh/my-dsh
git add docs/superpowers/specs/2026-11-10-talk-map-draft-attachments-design.md docs/superpowers/plans/2026-11-10-talk-map-draft-attachments.md plugins/dsh-talk-map-local/package.json plugins/dsh-talk-map-local/tsconfig.json plugins/dsh-talk-map-local/src/client plugins/dsh-talk-map-local/tests plugins/dsh-talk-map-local/client plugins/dsh-talk-map-local/lib
git commit -m "插件：对话地图新对话输入框支持粘贴/拖入图片与文件"
```
只 add 上述路径；不要带上 `plugins/dsh-purewhite-toolkit` 的既有改动。

- [ ] **Step 6: 交付说明**

告诉用户：
- 插件已装成 0.1.6；
- 刷新页面（⌘R）或重启桌面端后生效；
- 用法：地图 → 右键「新对话」→ 粘贴/拖入图片或文件 → 发送；
- 右侧抽屉会话仍走 dsh 原生输入框，白板其他位置保持原行为；
- 已知限制：上传在点发送后才开始；host 拒绝的图片会显示错误并保留草稿；文件夹拖入不支持。
