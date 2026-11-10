# dsh-talk-map-local

- 上游：https://github.com/Tasihi89/dsh-talk-map（本地大改后改名为 `dsh-talk-map-local`）
- 安装来源：本地源码，`pnpm pack` 出 tgz 后以 `file:` 依赖安装（宿主里用 `link:` 会触发 peer 依赖问题）
- 本机：修改版 0.1.5，相对上游 `b2d36d6` 共 33 项未提交改动（26 改 / 2 删 / 5 新增）：新增 `ChatPanel.tsx`、`ImageNode.tsx`（图片节点，会话里的图片可拖到白板并等比缩放）、`InteractionMenu.tsx`、`MapErrorBoundary.tsx`、`interactions.ts`；删除 `SpawnPreview.tsx`、`src/host/auto-sync.ts`。未回上游
- 当前安装包：`dsh-talk-map-local-0.1.5.tgz`（`pnpm pack` 产物，profile 以 `file:` 依赖指向它）
