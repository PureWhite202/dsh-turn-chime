# dsh-talk-map-local

- 上游：https://github.com/Tasihi89/dsh-talk-map（本地大改后改名为 `dsh-talk-map-local`）
- 安装来源：本地源码，`pnpm pack` 出 tgz 后以 `file:` 依赖安装（宿主里用 `link:` 会触发 peer 依赖问题）
- 本机：修改版 0.1.7（基于 0.1.5 的本地大改），未回上游。新增 `ChatPanel.tsx`、`ImageNode.tsx`（图片节点，会话里的图片可拖到白板并等比缩放）、`InteractionMenu.tsx`、`MapErrorBoundary.tsx`、`interactions.ts`、`draft-attachments.ts`（草稿卡粘贴/拖入图片与文件的纯函数）；对话地图草稿卡支持粘贴/拖入图片与普通文件，发送时随第一条消息上传；修复 macOS 交通灯与地图标题栏重叠；评审后修复分叉「完整对话」首句不能留空的回归，发送中冻结附件栏，补齐 abort 检查。
- 当前安装包：`dsh-talk-map-local-0.1.11.tgz`（`pnpm pack --ignore-scripts` 产物，profile 以 `file:` 依赖指向它）
- 0.1.8：双击空白 / 右键「新对话」直接创建会话并进入，不再弹草稿编辑框；草稿框改为 Shift+双击空白或右键「新对话（先填写）…」打开。共享逻辑抽到 `src/client/new-chat.ts`（纯函数，含单测）与 `src/client/map-create.ts`（建会话/落卡/开分组框）。E2E 新增「双击直接建会话」场景，草稿场景改为走右键菜单打开。
- 0.1.9：修复右键拖动也会弹出右键菜单。Chromium 在右键**按下**时就派发 `contextmenu`，原来的「指针移动过就不弹」判断在那一刻永远为假；改为按下时先挂起菜单请求，松开时按位移（>5px 视为拖动平移）决定是否打开，键盘 / macOS Ctrl+点击仍然立即打开。新增 `tests/e2e/context-menu-gesture.e2e.mjs`（右键点击、抖动点击、右键拖动、拖动后再点击四个场景）。
- 0.1.10：修复点击卡片偶尔「没反应、要点第二次」才切到右侧会话。两个原因叠加：① React Flow 的 `nodeClickDistance` 默认 0，按下到松开之间指针移动 1px 就吞掉节点 click（macOS 触控板点按常有 2–4px 漂移）；② 地图用「画布模型 → 节点对象」重建节点，拖动时每次位置变化都会换新对象，而 React Flow 重建内部节点时从对象上取 `measured`，新对象没有就短暂 `visibility: hidden`，落点掉到 pane 上。修法：给 `ReactFlow` 设 `nodeClickDistance={5}`（与右键拖动判定共用 `POINTER_CLICK_SLOP`），并在 `onNodesChange` 里记录 RF 回传的 dimensions、重建 card/frame 节点时带上 `measured`。≥6px 的明确拖动仍然只拖卡片、不弹会话；原有 draft-attachments E2E 增加「3px 抖动点击两张卡片、右侧抽屉依次切换」场景。
- 0.1.11：卡片绿点改成和主页一样的「完成未读」语义：只取 `completionUnread`（不再 OR 上 `summary.completed`），抽屉正在显示的会话不显示绿点（`activeChatSessionId` 透传），抽屉切换/关闭时若该会话仍未读，短暂借主栏让宿主清掉未读点再交还主栏（`clearUnreadAfterDrawer`）。修复「对话在抽屉里看着看着跑完，卡片冒绿点且点进去也不消失」。
