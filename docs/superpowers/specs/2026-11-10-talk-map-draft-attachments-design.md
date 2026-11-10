# 对话地图「新对话」草稿卡附件支持 — 设计（短）

- 日期：2026-11-10
- 范围：`dsh-talk-map-local` 0.1.5 本地修改版（`~/.dsh/my-dsh/plugins/dsh-talk-map-local`）
- 状态：待批准

## 意图

地图上右键 →「新对话」（以及双击空白）打开的草稿卡，输入框目前只支持文本。用户希望它像 dsh 自己的输入框一样，可以粘贴或拖入图片，并且**普通文件也一起支持**。

拖放归属按 A：只在草稿卡范围内接管 drop；右侧抽屉里已打开的会话仍由 dsh 原生输入框接收；白板其他位置维持现状（画布图片拖入仍生成图片节点）。

## 目标 / 非目标

目标：

- 粘贴（剪贴板里的文件/截图）与拖入（Finder 文件、右侧会话里拖出的图片、dsh 应用内图片）都能进入草稿。
- 图片显示缩略图，普通文件显示文件卡（图标、文件名、大小），均可移除。
- 发送时附件随第一条消息一起发出，支持“只发附件不发文字”。
- 附件与文字顺序稳定：按添加顺序在前，文字最后（与 dsh composer 一致）。

非目标：

- 文件夹/目录递归拖入。
- 白板任意位置的系统图片自动归属到某个会话；拖到会话卡片上直接投递。
- 发送后继续编辑附件、草稿自动保存附件。
- 音视频等 dsh 附件体系本身没有特殊支持的语义。

## 约束（已核实）

- `PromptContentPart`（`dsh-api-session-controller`）：`text` / `image`（inline base64）/ `file`（`receiptId`）。文件 part 必须引用**同一 Session** 的上传凭证，所以普通文件只能在会话创建后上传。
- `ctx.fileUpload` 提供 `upload(sessionId, Blob|bytes|stream, name?, signal?, onProgress?)` 与 `uploadImage(sessionId, Blob, mediaType, name?, signal?, onProgress?)`，都返回 `{ receiptId, ... }`（`dsh-client-file-upload`）。
- 图片接受类型：`image/png | image/jpeg | image/webp | image/gif`；其余按普通文件原样保存（dsh composer 同款判断）。
- `ctx.fileDrag.read(dataTransfer)` 可解析 dsh 应用内拖拽 token，得到原始 `File`（`dsh-client-ui-file-drag`）。
- `ui-attachment`、`ui-file-drag`、`file-upload` 均在 `@deepseek-ai/dsh-web-app` 的 bundle 中加载（本机 0.2.2-rc.1），可作为插件的硬依赖注入。
- 现有草稿语义：发送前不创建任何东西；发送成功后卡片落位并打开右侧会话。
- 右侧抽屉会话是 dsh 原生 `conversation.content`，其输入框已自带粘贴/拖放；本插件不接管它。

## 方案（已选）

**方案 1：发送时上传。**

点发送 → 按现有逻辑解析/创建工作区、创建会话（或 fork）→ 通过 `ctx.fileUpload` 按添加顺序上传附件（图片 `uploadImage`，文件 `upload`，带进度和 AbortSignal）→ 收集 receiptId → 应用模型选择 → 发送一条 `[...附件 receipt parts, 文字?]` 的 prompt → 卡片落位并打开右侧会话。

被否方案：

- 首次附加就建会话并上传：取消草稿会留下空会话，工作区/模式/模型必须在附件前锁定，与现有草稿设计冲突。
- 普通文件 inline base64：协议不支持，文件 part 只有 receiptId 一条路。

## 设计细节

1. **附件状态**（`DraftCard` 内）
   - `DraftAttachment = { id, kind: 'image'|'file', file: File, previewUrl?, mediaType? }`，按添加顺序保存。
   - 图片类型判定用 dsh 的 4 种 MIME；`image/svg+xml`、HEIC 等不是图片 attachment，按普通文件走。
   - 缩略图/文件卡 + 移除按钮；组件卸载时 revoke 所有 object URL。

2. **接收入口**
   - 粘贴：`onPaste` 读取 `clipboardData.items`（`kind === 'file'`）与 `clipboardData.files`；只有文件时 `preventDefault()`，文件和文字都有时让文字按浏览器默认行为进入 textarea。
   - 拖入：草稿卡根节点 `onDragEnter/onDragOver/onDrop`；识别 `dataTransfer.files`、`application/x-dsh-file`（`ctx.fileDrag.read`）、`application/x-talk-map-image`（fetch src → Blob → File）。拖入时卡片高亮并显示提示。
   - `onDrop` 必须 `preventDefault()` + `stopPropagation()`，避免落到画布的图片节点处理或背后 composer 的 document 监听。
   - 同一文件去重不做（用户可重复添加）；每次添加给出明确错误（例如 fetch 失败、dsh token 失效）。

3. **发送流程**
   - 解析工作区 → 创建会话/fork（现有分支逻辑不变）。
   - 逐个上传：`fileUpload.uploadImage` / `fileUpload.upload`；记录每个附件的上传进度，按钮显示“上传中 x/y”。
   - 上传全部成功后再 selectModel、发送 prompt、添加卡片与 fork 连线、`ensureFrame`、打开抽屉。
   - 上传被 host 拒绝：保留草稿与附件，显示错误；不添加地图卡片（已创建的空会话留在侧栏，与现有 prompt 失败路径一致）。
   - 上传期间允许 Esc 关闭草稿：AbortController 中止上传并忽略 AbortError。
   - 只发附件时 `sendDisabled` 不再要求文字非空；fork 模式同样适用（digest 模式仍要求注入摘要非空）。

4. **UI**
   - 草稿卡新增附件横向 rail：图片 56–64px 方形缩略图；文件卡显示文档图标、文件名、大小、扩展名。宽度不够时横向滚动。
   - 拖入时卡片边框高亮；`busy` 时显示上传进度；错误沿用现有错误行。
   - 所有交互元素加 `nodrag`，不触发 React Flow 节点拖动。

5. **i18n / 样式**
   - 中英新增：附件提示、移除、上传中、上传失败、图片/文件类型限制等约 6–8 条。
   - 新样式沿用 `--dsw-alias-*` 变量，跟随深浅色主题。

6. **依赖注入**
   - `src/client/index.ts` 的 `inject` 增加 `fileUpload`、`fileDrag`；`src/client/dsh.ts` 增加结构类型。
   - `MapServices` 增加 `fileUpload`、`fileDrag`；`attachServices` 传入。

## 影响文件

- `src/client/DraftCard.tsx`（主要改动）
- 新增 `src/client/draft-attachments.ts`（附件分类、内容拼装、base64 等纯函数，便于单测）
- `src/client/dsh.ts`、`src/client/index.ts`、`src/client/map-state.ts`
- `src/client/i18n.ts`、`src/client/talk-map.module.css`
- 构建产物 `lib/index.js`、`client/client.js`，重新打包 tgz 并安装到 `desktop` profile

## 验证

1. `pnpm run typecheck`、`pnpm run build`。
2. Node 单测（内置 `node:test`）覆盖 `draft-attachments.ts` 的纯函数：图片/文件分类、prompt content 顺序、只附件可发送、错误分支。
3. 隔离 E2E：用临时 `DSH_HOME` + 新端口启动一份独立 `dsh web`，Playwright 打开页面：
   - 打开地图 → 新对话 → 粘贴图片 → 缩略图出现 → 发送 → 新卡片出现，右侧会话消息带图；
   - 拖入普通文件 → 文件卡出现 → 发送 → 消息带文件名；
   - 只发附件、移除附件、非图片文件按普通文件处理；
   - 拖放不误投到画布/背后输入框。
4. 重新打包安装到 `desktop` profile，用户刷新页面后人工确认（安装说明提供）。

## 风险

- 上传凭证与刚创建会话/fork 的竞态：失败时提示并保留草稿，不静默丢附件。
- host 图片限制由部署配置决定：不在客户端硬编码数量/大小上限，直接展示 host 错误。
- React Flow 节点的 drop 传播/全局 composer document 监听：E2E 明确覆盖“只在草稿内接管”。
