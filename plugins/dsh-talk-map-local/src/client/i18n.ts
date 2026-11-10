/**
 * Two-locale copy dictionary. The default ('auto') reads <html lang>
 * directly — the pattern dsh-plugin-market uses, so no dependency on the
 * locale service; dsh sets the document language and anything starting with
 * "zh" renders Chinese. A user who picks a language in the map header
 * overrides that, and the choice is persisted in the canvas global
 * (canvas-store pushes it back here on every state change).
 */
import type { LocalePref } from '../shared/model.ts'

export type { LocalePref }
export type Locale = 'zh' | 'en'

const zh: Record<string, string> = {
  'map.title': '对话地图',
  'map.close': '关闭地图（Esc）',
  'map.toggle': '对话地图',
  'image.failed': '图片添加失败：',
  'image.added': '已添加图片',
  'map.empty': '地图是空的 —— 右键导入工作区或对话；双击空白直接开新对话',
  'map.sessions': '个会话',
  'map.chat': '会话窗口',
  'map.closeChat': '关闭会话窗口',
  'map.resizeDrawer': '拖动调整会话窗口宽度',
  'map.resizeDrawerHint': '拖动调宽，双击恢复默认',
  'map.sameSessionHint': '这个会话已经在主界面打开了。侧栏需要先把主界面临时切到同工作区的另一个会话，才能在这里打开它；当前没有可用的会话。可以点「刷新主页重试」再试一次（会话列表可能刚加载出来），或关闭地图继续在主界面输入。',
  'map.showMain': '关闭地图查看会话',
  'map.retryParking': '刷新主页重试',
  'map.retryParkingBusy': '正在重试……',
  'map.loading': '正在加载地图……',
  'map.loadError': '地图数据加载失败：',
  'map.crash': '地图界面出错了',
  'map.crashHint': '错误已被拦截。关闭地图后可以重新打开；如果反复出现，请把控制台报错发给维护者。',
  'map.crashRetry': '重试渲染',
  'card.running': '正在运行',
  'card.ghostTitle': '会话已不存在',
  'card.remove': '移除卡片',
  'card.pin': '置顶会话',
  'card.unpin': '取消置顶',
  'time.now': '刚刚',
  'time.m': ' 分钟前',
  'time.h': ' 小时前',
  'time.d': ' 天前',
  'edge.injected': '注入',
  'spawn.heading': '连线分叉：开一个带上下文的新对话',
  'spawn.from': '来源',
  'spawn.hint': '以下内容将注入新对话作为背景，可以编辑：',
  'spawn.generating': '正在生成摘要……',
  'spawn.noDigest': '（这段对话还没有摘要——可以先点卡片右上角的 ⟳ 生成，或直接在这里手写要带过去的背景。）',
  'spawn.confirm': '开新对话',
  'spawn.busy': '创建中……',
  'spawn.cancel': '取消',
  'spawn.mode.none': '不继承',
  'spawn.mode.digest': '摘要注入',
  'spawn.mode.full': '完整对话',
  'spawn.noneHint': '全新对话，只保留一条关联线。输入第一句话（回车发送）：',
  'spawn.fullHint': '新对话将携带这段对话的完整历史继续（dsh 原生分叉）。',
  'spawn.fullOptional': '第一句话可留空，直接开新对话（完整历史已经带上）。',
  'spawn.needText': '注入内容不能为空',
  'spawn.needFirstMessage': '请输入第一句话',
  'edge.none': '关联',
  'edge.full': '完整分叉',
  'inject.header': '【上下文注入 · 来自】',
  'inject.summary': '摘要：',
  'inject.findings': '关键结论：',
  'frame.ungrouped': '未分组',
  'draft.heading': '新对话',
  'draft.workspace': '工作区',
  'draft.model': '模型',
  'draft.preset': '模式',
  'draft.default': '默认',
  'draft.placeholder': '想聊什么？可粘贴/拖入图片或文件；回车发送，Shift+回车换行',
  'draft.send': '发送',
  'draft.sending': '发送中……',
  'draft.newWorkspace': '＋ 新建工作区',
  'draft.wsName': '名称',
  'draft.wsNamePlaceholder': '新工作区文件夹名',
  'draft.defaultSuffix': '（默认）',
  'draft.dropHint': '松开以添加图片或文件',
  'draft.removeAttachment': '移除附件',
  'draft.uploading': '上传中 {done}/{total}…',
  'draft.uploadFailed': '附件上传失败：',
  'draft.createFailed': '创建对话失败：',
  'draft.createNotReady': 'dsh 连接还没就绪，稍后再试',
  'draft.createNoWorkspace': '还没有工作区 —— 先右键空白新建一个工作区',
  'draft.attachFailed': '添加附件失败：',
  'draft.untitledFile': '未命名文件',
  'preset.standard': '标准模式',
  'preset.ptc': 'PTC 模式',
  'preset.minimal': '极简模式',
  'preset.cordis': '创造模式',
  'color.toolbar': '颜色',
  'color.clear': '清除颜色',
  'card.waiting': '等你回复',
  'card.waitingHint': '有需要你处理的选项，点击选择',
  'interact.aria': '待处理选项',
  'interact.questionTitle': '需要你选择',
  'interact.planTitle': '计划待审阅',
  'interact.approvalTitle': '工具 {tool} 请求越权执行',
  'interact.allow': '允许一次',
  'interact.reject': '拒绝',
  'interact.submit': '提交选择',
  'interact.busy': '提交中……',
  'interact.openChat': '打开会话处理',
  'interact.needsChat': '这个问题需要文字回答。',
  'interact.needsChatHint': '在会话窗口里回答会带上完整上下文。',
  'card.done': '已完成',
  'card.foreign': '外部',
  'card.foreignHint': '该会话属于「{name}」，只是位置落在本分组框内，不计入本组。',
  'frame.unknown': '分组',
  'frame.defaultWs': '默认工作区',
  'map.archivedHint': '该会话已归档，发送新消息不会得到回复。',
  'map.unarchive': '取消归档',
  'frame.foreign': '外部 {n}',
  'frame.foreignHint': '本框内有 {n} 张卡片属于其它工作区，仅位置在框内，不计入本组。',
  'frame.hiddenTitle': '还有卡片被折叠在框外，放大分组框可见',
  'menu.empty': '（没有可选项）',
  'menu.search': '搜索…',
  'menu.alreadyImported': '已在地图 · 点击同步新会话',
  'menu.newWs': '新建工作区',
  'menu.createAndImport': '创建并导入',
  'menu.working': '处理中……',
  'map.zoom100': '恢复 100% 缩放',
  'hotkey.title': '地图切换快捷键 · 点击后按新组合键修改',
  'hotkey.capturing': '按下新组合键…',
  'menu.newChat': '新对话',
  'menu.newChatDraft': '新对话（先填写）…',
  'menu.importWs': '导入工作区',
  'menu.importSession': '导入对话',
  'menu.moveGroup': '移动到分组（仅地图）',
  'menu.noGroup': '移出分组（自由卡片）',
  'menu.open': '打开对话',
  'menu.forkChat': '从此对话分叉…',
  'menu.removeCard': '从地图移除',
  'edge.push': '推送最新摘要',
  'edge.pushNoDigest': '来源还没有摘要',
  'edge.delete': '删除连线',
  'toast.pushed': '已推送给「{to}」',
  'toast.notLive': '目标对话未激活——先打开它一次再推送',
  'toast.pushFailed': '推送失败：',
  'push.header': '【来自「{from}」的更新 · {time}】',
  'lang.hint': '界面语言：{current} · 点击切换到{next}',
  'lang.auto': '自动',
  'lang.zh': '中文',
  'lang.en': 'English',
  'menu.syncGroup': '同步该工作区的新会话',
  'menu.removeGroup': '移除分组（连同卡片）',
  'menu.archive': '归档',
  'toast.archived': '已归档',
  'toast.unarchived': '已取消归档',
  'toast.undo': '取消',
  'toast.archiveFailed': '归档失败：',
  'toast.unarchiveFailed': '取消归档失败：',
}

const en: Record<string, string> = {
  'map.title': 'Talk Map',
  'map.close': 'Close map (Esc)',
  'map.toggle': 'Talk Map',
  'image.failed': 'Failed to add image: ',
  'image.added': 'Image added',
  'map.empty': 'The map is empty — right-click to import a workspace or conversation; double-click to start a chat',
  'map.sessions': 'sessions',
  'map.chat': 'Conversation panel',
  'map.closeChat': 'Close conversation panel',
  'map.resizeDrawer': 'Resize the conversation panel',
  'map.resizeDrawerHint': 'Drag to resize, double-click to reset',
  'map.sameSessionHint': 'This conversation is already open in the main view. The panel parks the main view on another conversation in the same workspace to open it here, and none is available right now. Try 「Refresh main view & retry」 (the session list may still be loading), or close the map to keep typing in the main view.',
  'map.showMain': 'Close map to view it',
  'map.retryParking': 'Refresh main view & retry',
  'map.retryParkingBusy': 'Retrying…',
  'map.loading': 'Loading map…',
  'map.loadError': 'Failed to load map data:',
  'map.crash': 'The map hit an error',
  'map.crashHint': 'The error was contained. Close the map and open it again; if it keeps happening, send the console error to the maintainer.',
  'map.crashRetry': 'Retry',
  'card.running': 'running',
  'card.ghostTitle': 'Session no longer exists',
  'card.remove': 'Remove card',
  'card.pin': 'Pin session',
  'card.unpin': 'Unpin session',
  'time.now': 'now',
  'time.m': 'm ago',
  'time.h': 'h ago',
  'time.d': 'd ago',
  'edge.injected': 'injected',
  'spawn.heading': 'Fork with context',
  'spawn.from': 'From',
  'spawn.hint': 'This text will be injected into the new session as background — edit freely:',
  'spawn.generating': 'Generating summary…',
  'spawn.noDigest': '(No digest yet — hit ⟳ on the card first, or write the context to carry over by hand.)',
  'spawn.confirm': 'Start session',
  'spawn.busy': 'Creating…',
  'spawn.cancel': 'Cancel',
  'spawn.mode.none': 'No context',
  'spawn.mode.digest': 'Inject digest',
  'spawn.mode.full': 'Full history',
  'spawn.noneHint': 'A fresh conversation, linked visually only. Type the first message (Enter sends):',
  'spawn.fullHint': 'The new conversation continues with this one\'s FULL history (dsh-native fork).',
  'spawn.fullOptional': 'The first message is optional — leave it empty to open the fork directly.',
  'spawn.needText': 'Injection text must not be empty',
  'spawn.needFirstMessage': 'Type the first message',
  'edge.none': 'linked',
  'edge.full': 'full fork',
  'inject.header': '[Context injected from] ',
  'inject.summary': 'Summary: ',
  'inject.findings': 'Key findings:',
  'frame.ungrouped': 'Ungrouped',
  'draft.heading': 'New conversation',
  'draft.workspace': 'Workspace',
  'draft.model': 'Model',
  'draft.preset': 'Preset',
  'draft.default': 'Default',
  'draft.placeholder': 'What is this about? Paste or drop images/files; Enter sends, Shift+Enter for a newline',
  'draft.send': 'Send',
  'draft.sending': 'Sending…',
  'draft.newWorkspace': '＋ New workspace',
  'draft.wsName': 'Name',
  'draft.wsNamePlaceholder': 'New workspace folder name',
  'draft.defaultSuffix': ' (default)',
  'draft.dropHint': 'Release to add images or files',
  'draft.removeAttachment': 'Remove attachment',
  'draft.uploading': 'Uploading {done}/{total}…',
  'draft.uploadFailed': 'Attachment upload failed: ',
  'draft.createFailed': 'Could not create the conversation: ',
  'draft.createNotReady': 'The dsh connection is not ready yet — try again in a moment',
  'draft.createNoWorkspace': 'No workspace yet — right-click empty canvas and create one first',
  'draft.attachFailed': 'Could not add attachment: ',
  'draft.untitledFile': 'Untitled file',
  'preset.standard': 'Standard mode',
  'preset.ptc': 'PTC mode',
  'preset.minimal': 'Minimal mode',
  'preset.cordis': 'Creator mode',
  'color.toolbar': 'Color',
  'color.clear': 'Clear color',
  'card.waiting': 'needs you',
  'card.waitingHint': 'Needs your input — click to choose',
  'interact.aria': 'Pending choice',
  'interact.questionTitle': 'Your input is needed',
  'interact.planTitle': 'Plan awaiting review',
  'interact.approvalTitle': 'Tool {tool} requests privileged execution',
  'interact.allow': 'Allow once',
  'interact.reject': 'Reject',
  'interact.submit': 'Submit choices',
  'interact.busy': 'Submitting…',
  'interact.openChat': 'Open in conversation',
  'interact.needsChat': 'This question needs a typed answer.',
  'interact.needsChatHint': 'Answering in the conversation panel keeps the full context.',
  'card.done': 'done',
  'card.foreign': 'external',
  'card.foreignHint': 'This Session belongs to "{name}". It only sits inside this frame and is not part of this group.',
  'frame.unknown': 'Group',
  'frame.defaultWs': 'Default workspace',
  'map.archivedHint': 'This conversation is archived — new messages will not be answered.',
  'map.unarchive': 'Unarchive',
  'frame.foreign': '{n} external',
  'frame.foreignHint': '{n} cards in this frame belong to other workspaces; they only sit inside the frame and are not part of this group.',
  'frame.hiddenTitle': 'Some cards are folded outside the frame — enlarge it to see them',
  'menu.empty': '(nothing to pick)',
  'menu.search': 'Search…',
  'menu.alreadyImported': 'on map · click to sync new sessions',
  'menu.newWs': 'New workspace',
  'menu.createAndImport': 'Create & import',
  'menu.working': 'Working…',
  'map.zoom100': 'Reset zoom to 100%',
  'hotkey.title': 'Map toggle hotkey · click, then press a new combo',
  'hotkey.capturing': 'Press a combo…',
  'menu.newChat': 'New conversation',
  'menu.newChatDraft': 'New conversation (fill in first)…',
  'menu.importWs': 'Import workspace',
  'menu.importSession': 'Import conversation',
  'menu.moveGroup': 'Move to group (map only)',
  'menu.noGroup': 'Remove from group (free card)',
  'menu.open': 'Open conversation',
  'menu.forkChat': 'Fork from this conversation…',
  'menu.removeCard': 'Remove from map',
  'edge.push': 'Push latest digest',
  'edge.pushNoDigest': 'source has no digest yet',
  'edge.delete': 'Delete edge',
  'toast.pushed': 'Pushed to "{to}"',
  'toast.notLive': 'Target conversation is not active — open it once, then push again',
  'toast.pushFailed': 'Push failed: ',
  'push.header': '[Update from "{from}" · {time}]',
  'lang.hint': 'Interface language: {current} · click to switch to {next}',
  'lang.auto': 'Auto',
  'lang.zh': '中文',
  'lang.en': 'English',
  'menu.syncGroup': 'Sync new sessions of this workspace',
  'menu.removeGroup': 'Remove group (with its cards)',
  'menu.archive': 'Archive',
  'toast.archived': 'Archived',
  'toast.unarchived': 'Archive undone',
  'toast.undo': 'Undo',
  'toast.archiveFailed': 'Archive failed: ',
  'toast.unarchiveFailed': 'Undo failed: ',
}

/** The order the header button cycles through. */
export const LOCALE_CYCLE: readonly LocalePref[] = ['auto', 'zh', 'en']

let preference: LocalePref = 'auto'
const localeListeners = new Set<() => void>()

function documentLocale(): Locale {
  if (typeof document === 'undefined') return 'en'
  return (document.documentElement.lang ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** What the stored setting says; 'auto' when the user never picked one. */
export function localePref(): LocalePref {
  return preference
}

/** The language actually rendered right now. */
export function activeLocale(): Locale {
  return preference === 'auto' ? documentLocale() : preference
}

/**
 * Apply a preference. Notifying only on a real change matters: canvas-store
 * calls this on EVERY state change (card drags included), and a notification
 * remounts the whole overlay.
 */
export function setLocalePref(next: LocalePref): void {
  if (next === preference) return
  preference = next
  for (const listener of localeListeners) listener()
}

export function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener)
  return () => { localeListeners.delete(listener) }
}

/**
 * Translate, optionally interpolating {name} placeholders. Single-pass
 * regex interpolation is the ONLY sanctioned way to fill templates:
 * chained String.replace at call sites both expands $-patterns lurking in
 * real values (conversation titles) and re-scans earlier insertions (a
 * title containing a literal "{time}" would swallow the next parameter).
 */
export function t(key: string, params?: Record<string, string>): string {
  const dict = activeLocale() === 'zh' ? zh : en
  const template = dict[key] ?? en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}
