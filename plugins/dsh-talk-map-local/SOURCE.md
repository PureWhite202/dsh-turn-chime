# dsh-talk-map-local

- 上游：https://github.com/Tasihi89/dsh-talk-map（本地大改后改名为 `dsh-talk-map-local`）
- 安装来源：本地源码，`pnpm pack` 出 tgz 后以 `file:` 依赖安装（宿主里用 `link:` 会触发 peer 依赖问题）
- 本机：修改版 0.1.7（基于 0.1.5 的本地大改），未回上游。新增 `ChatPanel.tsx`、`ImageNode.tsx`（图片节点，会话里的图片可拖到白板并等比缩放）、`InteractionMenu.tsx`、`MapErrorBoundary.tsx`、`interactions.ts`、`draft-attachments.ts`（草稿卡粘贴/拖入图片与文件的纯函数）；对话地图草稿卡支持粘贴/拖入图片与普通文件，发送时随第一条消息上传；修复 macOS 交通灯与地图标题栏重叠；评审后修复分叉「完整对话」首句不能留空的回归，发送中冻结附件栏，补齐 abort 检查。
- 当前安装包：`dsh-talk-map-local-0.1.23.tgz`（2026-11-12 05:02 重新打包，文档/元数据本地化后同步；`npm pack --ignore-scripts` 产物，profile 以 `file:` 依赖指向它；md5 `914397E55023147609B496334C1A1D41`）
- 0.1.8：双击空白 / 右键「新对话」直接创建会话并进入，不再弹草稿编辑框；草稿框改为 Shift+双击空白或右键「新对话（先填写）…」打开。共享逻辑抽到 `src/client/new-chat.ts`（纯函数，含单测）与 `src/client/map-create.ts`（建会话/落卡/开分组框）。E2E 新增「双击直接建会话」场景，草稿场景改为走右键菜单打开。
- 0.1.9：修复右键拖动也会弹出右键菜单。Chromium 在右键**按下**时就派发 `contextmenu`，原来的「指针移动过就不弹」判断在那一刻永远为假；改为按下时先挂起菜单请求，松开时按位移（>5px 视为拖动平移）决定是否打开，键盘 / macOS Ctrl+点击仍然立即打开。新增 `tests/e2e/context-menu-gesture.e2e.mjs`（右键点击、抖动点击、右键拖动、拖动后再点击四个场景）。
- 0.1.10：修复点击卡片偶尔「没反应、要点第二次」才切到右侧会话。两个原因叠加：① React Flow 的 `nodeClickDistance` 默认 0，按下到松开之间指针移动 1px 就吞掉节点 click（macOS 触控板点按常有 2–4px 漂移）；② 地图用「画布模型 → 节点对象」重建节点，拖动时每次位置变化都会换新对象，而 React Flow 重建内部节点时从对象上取 `measured`，新对象没有就短暂 `visibility: hidden`，落点掉到 pane 上。修法：给 `ReactFlow` 设 `nodeClickDistance={5}`（与右键拖动判定共用 `POINTER_CLICK_SLOP`），并在 `onNodesChange` 里记录 RF 回传的 dimensions、重建 card/frame 节点时带上 `measured`。≥6px 的明确拖动仍然只拖卡片、不弹会话；原有 draft-attachments E2E 增加「3px 抖动点击两张卡片、右侧抽屉依次切换」场景。
- 0.1.11：卡片绿点改成和主页一样的「完成未读」语义：只取 `completionUnread`（不再 OR 上 `summary.completed`），抽屉正在显示的会话不显示绿点（`activeChatSessionId` 透传），抽屉切换/关闭时若该会话仍未读，短暂借主栏让宿主清掉未读点再交还主栏（`clearUnreadAfterDrawer`）。修复「对话在抽屉里看着看着跑完，卡片冒绿点且点进去也不消失」。
- 0.1.12：右侧会话窗口支持拖动左边缘调宽（指针捕获，拖动中直接写 DOM 宽避免每次移动都重渲染对话；双击恢复 CSS 默认宽度；方向键 ±24px；宽度存 canvas global 并随地图持久化，宿主 `globalSchema` 补了 `drawerWidth` 字段，否则 zod 会把未知字段剥掉导致刷新后丢失）。draft-attachments E2E 增加「拖动加宽 / 双击复位」场景。
- 0.1.13：修复地图打开后点文件/链接报「sidebarRight: no session surface is mounted」的死窗。地图侧包一层 openResource/openTab，只在该错误下降级：文件用宿主 `session.openWorkspacePath` 交给系统默认应用，网页链接开新窗口，其余给 toast。新增 `sidebar-fallback` 单测（14 条）。
- 0.1.14：侧栏兜底加固——安装流程「永不抛错」（服务查找抛错、控制器冻结、文案/依赖缺失都只 `console.warn`，不中断地图注册）；copy 与 toast 从入口注入，wire 不再依赖宿主 UI 模块；补 wire 单测（6 条）。
- 0.1.15–0.1.22：没有逐版本的提交或说明可考，内容随 0.1.23 的整目录同步一并进仓库：卡片「地图标题」（`title` 只落在卡片上，改它不动会话标题；右键「编辑标题 / 保存标题 / 恢复默认标题」）、右侧会话窗口的「锁定」图钉（锁定后不随地图选中切换），以及对应的 i18n、CSS 与 E2E 调整。
- 0.1.23：此后未再上调版本号，以下改动都包含在 0.1.23 包里：新对话改为先落虚线临时占位框（发出首句转正；未发就关则删框并归档空会话）；右侧会话窗口与主页新对话支持选择 Agent 预设（模式），首句后只读显示；连线分叉改为落点虚线占位框 + 抽屉「分叉设置」（不继承 / 摘要注入 / 完整对话，可编辑摘要，工作区 / 模型 / 模式 / 附件 / 第一句），创建后自动选中新卡片；连线按拉线起手的锚点绘制（修复从卡片底边拉线却从右边出线）；卡片「编辑标题」在有自定义标题时预填输入框。
