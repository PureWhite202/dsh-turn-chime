# dsh-purewhite-toolkit（纯白莱茵自用工具集）

自用 DSH 插件合集。现在只有一个工具：`screenshot`。后续加工具时直接往 `index.js` 里加定义，不用新建插件包。

## 工具：screenshot

截取当前桌面（Windows / macOS）并**直接把图片作为内容块返回给模型**，不需要再调用 `read_image`。Windows 走自编译的 C# helper，macOS 走系统 `screencapture` + `sips`，都不需要第三方依赖。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `target` | `screen` / `window` / `region` | `screen` | 截取目标 |
| `window` | string | — | `target=window` 时用：窗口标题子串，不区分大小写（macOS 标题不匹配时再匹配进程名） |
| `hwnd` | integer | — | 精确窗口编号：Windows 为 HWND，macOS 为 CGWindowID；优先级高于 `window` |
| `restore` | boolean | `false` | 目标窗口最小化时是否临时恢复后截图（仅 Windows；macOS 不支持，会尝试直接捕获并给警告） |
| `region` | `{x,y,width,height}` | — | `target=region` 时用；Windows 为虚拟桌面物理像素，macOS 为点（原点在主屏左上角） |
| `monitor` | integer | `0` | 显示器序号（1 起）；0 = 所有屏幕合成 |
| `scale` | number | — | 0.1–1 缩放，省 token |
| `format` | `png` / `jpeg` | `png` | — |
| `cursor` | boolean | `false` | 是否把鼠标指针画进图里 |
| `outDir` | string | 会话工作目录根 | 保存目录，相对路径按会话工作目录解析 |
| `fileName` | string | 自动生成 | 保存文件名 |
| `save` | boolean | `true` | `false` 时只返回图片不落盘 |

返回结构：

```json
{ "ok": true, "path": "...", "width": 1600, "height": 1000, "bytes": 223841,
  "capture": { "kind": "screen", "bounds": {...} },
  "image": { "attachmentId": "...", "mediaType": "image/png", "bytes": 223841,
             "width": 1600, "height": 1000, "name": "screen-20261109-045917.png" },
  "warnings": [] }
```

失败时返回 `{ ok: false, code, message }`，`code` 取值：

| code | 含义 |
|---|---|
| `WindowNotFound` | 标题/进程名/编号没匹配到窗口，`message` 里附可见窗口列表 |
| `WindowMinimized` | 目标窗口最小化且 `restore=false`（macOS 不支持自动恢复） |
| `WindowNotVisible` | 窗口存在但不可见（Windows） |
| `BLANK_CAPTURE` | 截到纯色画面（锁屏、UAC 弹窗、GPU 合成空表面、没给屏幕录制权限） |
| `RegionOutsideScreen` | 区域与屏幕不相交 |
| `RegionMissing` / `WindowSelectorMissing` | region 尺寸缺失 / window 与 hwnd 都没传 |
| `SCREEN_RECORDING_DENIED` | macOS 没给「屏幕录制」权限（`error.message` 里有授权步骤） |
| `HELPER_BUILD_FAILED` / `HELPER_COMPILER_MISSING` | Windows helper 编译失败且无法回退 |
| `CAPTURE_TIMEOUT` | 截图进程超时（20 秒） |
| `CAPTURE_SPAWN_FAILED` / `CAPTURE_FAILED` / `CONVERT_FAILED` | 子进程起不来 / 截图失败 / 转码失败 |

## 技能：sync-config（2026-11-10 新增）

插件自带一个技能，随插件加载注册进宿主技能表（`ctx.skills.register`），不需要软链到 `~/.agents/skills`。

- 文件：`skills/sync-config/SKILL.md`
- 触发：输入 `/sync-config`（技能和命令共用 `/` 菜单），或说「对比本机和云端」「同步个人配置」
- 内容：全自然语言。仓库与 SSH 连接信息、本机/云端各指什么、对比步骤、报告格式、只读与确认规矩、拉取/推送命令，都写在正文里
- 关掉：配置项 `skills: false`

## 只读模式（Agent 预设 + 权限预设，2026-11-11 新增）

bundle 里声明了一个 `readonly` Agent 预设（模式下拉里的「只读模式」），外加它的执行守卫 `readonly-guard.js`：

- 预设的插件清单与「标准模式」逐项一致（persona、文件工具、bash/pwsh、搜索、子代理、压缩、技能都保留），只是执行时被钉成只读，不是阉割版；
- 守卫在会话**第一轮**的 `agent/pre-step` 里追加 `sandbox/mode = read-only` 与 `approval/policy = never`：fs-sandbox 和 Windows ACL 沙箱拒绝一切写、删、移，模型申请升权会被直接拒绝，不弹审批；
- 只读会话每轮额外收到一句运行时上下文（`readonly:mode`）：可读整台电脑、禁止改动文件、不要申请升权。它排在内置 sandbox 策略行之后，用来抵消那句「先试试、被拒再申请」的措辞；
- 只在首轮钉一次，后续轮次和恢复会话都不再改写，所以手动切权限不会被覆盖；子代理默认继承预设，也会被同样钉住；
- **受控出口**：模型可以调用 `request_standard_mode` 申请解除只读，但走 `ctx.userQuestions` 的阻塞式人工确认，只有用户选「允许切换到标准模式」才写入解除只读的事件；拒绝、跳过或确认通道不可用都保持只读。这个工具只在只读会话里出现在工具目录（`tools.register(..., { when })`）；
- 解除只读后写入的旋钮默认是 `danger-full-access` / `never`（和这台机器 profile 的默认权限预设一致），可用下面三个配置键改；Agent 预设不能中途切换，所以顶部模式标签仍显示「只读模式」；
- 左下角权限下拉里的「只读模式」（键 `read-only-mode`）来自 profile 的 `cordis.patch.yml`，不是本插件；它和 Agent 预设共用同一个名字，让权限芯片显示「只读模式」而不是 `Custom`。

配置（`cordis.patch.yml` 里 `readonly-guard` 行的 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `preset` | `readonly` | 要钉成只读的 Agent 预设 id |
| `permissionPreset` | `read-only-mode` | 写进会话日志的权限预设名，影响权限芯片的推导显示 |
| `writablePreset` | `danger-full-access` | 用户批准后写入的权限预设名 |
| `writableMode` | `danger-full-access` | 用户批准后写入的沙箱模式 |
| `writableApproval` | `never` | 用户批准后写入的审批策略 |

改动后如果模式下拉里没有「只读模式」，在插件管理器里把 `dsh-purewhite-toolkit` 关一次再开（触发重新组合），或者重启 DSH。

## 配置

`cordis.patch.yml` 里 `config`，全部可省略：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册工具 |
| `toolName` | `screenshot` | 工具名，避开同名冲突时可改 |
| `maxLongEdge` | `1600` | 图片长边上限，0 = 不缩放 |
| `format` | `png` | 默认格式 |
| `saveDir` | `''` | 默认保存目录，空 = 会话工作目录根 |
| `backend` | `auto` | `auto` / `helper` / `powershell`（Windows）；macOS 恒走 `screencapture`，该键只做兼容 |
| `cursor` | `false` | 默认是否画鼠标指针 |
| `blankUniformity` | `0.995` | 判定纯色画面的阈值 |
| `skills` | `true` | 是否注册插件自带的技能（`skills/` 目录） |

## 构建与测试

```bash
node scripts/build-helper.mjs      # Windows：编译 build/dshtool-capture.exe（csc，约 0.2 秒）
node test/smoke.mjs                # 冒烟测试：纯函数单测 + 真截一张屏 + 区域 + 窗口错误路径
node test/readonly-guard.test.mjs  # 只读守卫单测：钉住/幂等/非首轮/提示词/申请工具（12 个场景）
```

macOS 不需要构建步骤（系统自带 `screencapture` / `sips` / `osascript`），直接 `node test/smoke.mjs`。

`build/` 是产物目录，不入库（`.gitignore` 已忽略）。首次执行工具时若 exe 不存在或比 `.cs` 旧，会自动重编译。

## 实现说明

- **为什么自己编译 exe**：本机实测 PowerShell 子进程截图 1.35–1.59 秒/次（裸启动就 0.95 秒），csc 编译的 C# helper 只要 0.19–0.22 秒，且天然 DPI 感知。工具层端到端实测：整屏 284–302 毫秒（含落盘与附件），窗口截图约 382 毫秒。helper 由 `native/Capture.cs` 单文件编译，编译耗时约 0.2 秒，不引入任何打包链。
- **为什么截图先写 `build/.scratch` 再复制**：该 exe 位于工作区内时，Windows 侧只允许它写工作区内的路径（实测 D:\tmp、%TEMP% 都会返回 GDI+ 一般性错误）。所以 helper 只写自己目录下的临时文件，最终落盘由宿主机进程用 Node `fs` 完成。这样即使保存失败，图片仍能通过附件返回。
- **图片通路**：`ctx.attachments.saveImage()` 落成附件引用，`render` 返回 `[{type:'text'},{type:'image',attachment}]`，与官方 `read_image` 一致（`@deepseek-ai/dsh-tool-fs` 的 `imageReadContent`）。附件服务不可用时自动降级为只给路径。
- **窗口截图**：`PrintWindow` + `PW_RENDERFULLCONTENT`。被遮挡、非前台、比屏幕还大的窗口都能截；最小化窗口拿不到内容（DWM 不渲染），`restore=true` 时用 `SW_SHOWNOACTIVATE` 临时显示 → 截图 → 再最小化，全程不抢焦点，窗口会可见约 0.4 秒。
- **DPI**：目标窗口是 DPI 不感知的老程序时，按它的 DPI 缩放级别修正位图尺寸，避免右下角出现大片留白。

## macOS 实现（2026-11-10 新增）

- **截屏**：`/usr/sbin/screencapture -x -t png`。整屏按 `NSScreen` 的 frame 算所有显示器的联合矩形，用 `-R` 一次截出（多显示器按桌面布局排布，显示器之间的空隙是黑的）；`monitor=N` 走 `-D N`（1 = 主显示器）。
- **区域**：`-R x,y,w,h`，坐标单位是**点**（Retina 上输出 2 倍像素），原点在主显示器左上角。
- **窗口**：JXA（`osascript -l JavaScript`）调 `CGWindowListCopyWindowInfo` 列出窗口，按「进程名精确 > 标题精确 > 标题前缀 > 标题包含 > 进程名包含」打分挑选，然后 `screencapture -o -l <CGWindowID>`（不带阴影）。`hwnd` 直接当 CGWindowID。
- **缩放/转档/统计**：`sips -Z` 缩长边，`sips -s format jpeg` 转档（质量 88），再把图缩到 24px 的 BMP 上采样算亮度和颜色集中度，纯色判定口径与 Windows helper 一致。
- **权限**：首次使用需要在「系统设置 → 隐私与安全性 → 屏幕录制」里勾选宿主 App（DeepSeek Harness）并重启。没授权时 `screencapture` 可能只截到壁纸、或返回退出码 1；后者会被归类成 `SCREEN_RECORDING_DENIED`，前者会被 `BLANK_CAPTURE` 拦住。

## 已知限制

- Windows 依赖 user32 / GDI+ / .NET Framework 4.x；macOS 依赖系统自带的 `screencapture` / `sips` / `osascript`。
- macOS 上最小化窗口**不能**自动恢复；而且系统 API 区分不了“最小化”和“在其它桌面/Space”，两者都会先返回 `WindowMinimized`，传 `restore=true` 才会尝试直接捕获（截到空白就归为 `BLANK_CAPTURE`）；窗口截图不带阴影。
- macOS 的窗口标题需要「屏幕录制」权限才读得到；没权限时只能按进程名匹配。
- 没有 `csc.exe` 时 Windows 退到 PowerShell 兜底：只有整屏能力，每次约 1.5 秒。
- 硬件加速视频、全屏独占游戏、DRM 保护内容、部分 UWP 应用可能截到黑图。
- 锁屏、UAC 提权弹窗期间截不到真实桌面。
- 跨虚拟桌面（Windows 多桌面）的窗口行为未验证。

## 安装

profile 里按普通 bundle 安装（`link:` 指向本目录），宿主会读 `package.json` 的 `dsh.bundle.patch`：

```bash
# 方式一：插件管理器（推荐，热应用）
#   在 DSH 里执行 plugin_manager install_bundle target=link:<本目录绝对路径>

# 方式二：写进 profile 依赖后装
#   "dsh-purewhite-toolkit": "link:D:/Document/deepseek-harness/default-workspace/my-dsh/plugins/dsh-purewhite-toolkit"
#   pnpm install
```

安装后新开会话，模型工具列表里应出现 `screenshot`。

## 验证记录（2026-11-09，本机 Windows 11 / DSH 0.2.2-rc.1）

- 新开会话（独立 agent）验证：工具列表出现 `screenshot`；调用 `target=screen, save=false, scale=0.4` 后模型收到的是 image 内容块（1024x640、223715 字节、image/png），不是只有文字和路径。这条同时证明第三方 bundle 里 `ctx.get('attachments')` 可用。
- 整屏、指定窗口（Chrome / VS Code / 资源管理器 / 微信）、最小化窗口 `restore=true` 均截到真实内容。
- 最小化窗口不加 `restore` 返回 `WindowMinimized`，错误信息里带可见窗口候选标题。
- 默认落盘位置：不传 `outDir` 时写到会话工作目录根，文件名 `screen-YYYYMMDD-HHmmss.png`。
- PowerShell 兜底路径可用（仅整屏，800x500 验证通过）。
- 端到端耗时：整屏 284–302 毫秒，窗口 382 毫秒。

## 验证记录（2026-11-10，本机 macOS 26.6 / DSH 0.2.2-rc.1）

- `node test/smoke.mjs` 全部通过：整屏 1176x764（scale=0.4）、区域 200x120（200x120 点 × 2 倍 ÷ 2）、相对目录、窗口不存在、`save=false`、BMP 统计单测、窗口匹配优先级单测、错误归类单测。
- 手动验证：`target=window, window="DeepSeek Harness"` 命中宿主窗口（CGWindowID 181，1280x820 点）；`hwnd=181` 同样命中；`target=screen, monitor=1` 可用；`format=jpeg` 正常（sips 质量 88）；越界 region 返回 `RegionOutsideScreen`。
- 宿主热加载后 `screenshot` 工具可直接调用（截图内容块正常返回）。
