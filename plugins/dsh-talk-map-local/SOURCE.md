# dsh-talk-map-local

- 上游：https://github.com/Tasihi89/dsh-talk-map（本地大改后改名为 `dsh-talk-map-local`）
- 安装来源：本地源码，`pnpm pack` 出 tgz 后以 `file:` 依赖安装（宿主里用 `link:` 会触发 peer 依赖问题）
- 本机：修改版 0.1.7（基于 0.1.5 的本地大改），未回上游。新增 `ChatPanel.tsx`、`ImageNode.tsx`（图片节点，会话里的图片可拖到白板并等比缩放）、`InteractionMenu.tsx`、`MapErrorBoundary.tsx`、`interactions.ts`、`draft-attachments.ts`（草稿卡粘贴/拖入图片与文件的纯函数）；对话地图草稿卡支持粘贴/拖入图片与普通文件，发送时随第一条消息上传；修复 macOS 交通灯与地图标题栏重叠；评审后修复分叉「完整对话」首句不能留空的回归，发送中冻结附件栏，补齐 abort 检查。
- 当前安装包：`dsh-talk-map-local-0.1.7.tgz`（`pnpm pack --ignore-scripts` 产物，profile 以 `file:` 依赖指向它）
