# dsh-purewhite-toolkit（纯白莱茵自用工具集）

自用 DSH 插件合集。现在只有一个工具：`screenshot`。后续加工具时直接往 `index.js` 里加定义，不用新建插件包。

## 工具：screenshot

截取 Windows 桌面并**直接把图片作为内容块返回给模型**，不需要再调用 `read_image`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `target` | `screen` / `window` / `region` | `screen` | 截取目标 |
| `window` | string | — | `target=window` 时用：窗口标题子串，不区分大小写 |
| `hwnd` | integer | — | 精确窗口句柄，优先级高于 `window` |
| `restore` | boolean | `false` | 目标窗口最小化时是否临时恢复后截图 |
| `region` | `{x,y,width,height}` | — | `target=region` 时用，虚拟桌面物理像素 |
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
| `WindowNotFound` | 标题没匹配到窗口，`message` 里附可见窗口标题列表 |
| `WindowMinimized` | 目标窗口最小化且 `restore=false` |
| `WindowNotVisible` | 窗口存在但不可见 |
| `BLANK_CAPTURE` | 截到纯色画面（锁屏、UAC 弹窗、GPU 合成空表面） |
| `RegionOutsideScreen` | 区域与虚拟屏幕不相交 |
| `HELPER_BUILD_FAILED` / `HELPER_COMPILER_MISSING` | helper 编译失败且无法回退 |
| `CAPTURE_TIMEOUT` | 截图进程超过 20 秒 |

## 配置

`cordis.patch.yml` 里 `config`，全部可省略：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册工具 |
| `toolName` | `screenshot` | 工具名，避开同名冲突时可改 |
| `maxLongEdge` | `1600` | 图片长边上限，0 = 不缩放 |
| `format` | `png` | 默认格式 |
| `saveDir` | `''` | 默认保存目录，空 = 会话工作目录根 |
| `backend` | `auto` | `auto` / `helper` / `powershell` |
| `cursor` | `false` | 默认是否画鼠标指针 |
| `blankUniformity` | `0.995` | 判定纯色画面的阈值 |

## 构建与测试

```bash
node scripts/build-helper.mjs      # 编译 build/dshtool-capture.exe（csc，约 0.2 秒）
node test/smoke.mjs                # 冒烟测试：真截一张屏 + 窗口错误路径
```

`build/` 是产物目录，不入库（`.gitignore` 已忽略）。首次执行工具时若 exe 不存在或比 `.cs` 旧，会自动重编译。

## 实现说明

- **为什么自己编译 exe**：本机实测 PowerShell 子进程截图 1.35–1.59 秒/次（裸启动就 0.95 秒），csc 编译的 C# helper 只要 0.19–0.22 秒，且天然 DPI 感知。工具层端到端实测：整屏 284–302 毫秒（含落盘与附件），窗口截图约 382 毫秒。helper 由 `native/Capture.cs` 单文件编译，编译耗时约 0.2 秒，不引入任何打包链。
- **为什么截图先写 `build/.scratch` 再复制**：该 exe 位于工作区内时，Windows 侧只允许它写工作区内的路径（实测 D:\tmp、%TEMP% 都会返回 GDI+ 一般性错误）。所以 helper 只写自己目录下的临时文件，最终落盘由宿主机进程用 Node `fs` 完成。这样即使保存失败，图片仍能通过附件返回。
- **图片通路**：`ctx.attachments.saveImage()` 落成附件引用，`render` 返回 `[{type:'text'},{type:'image',attachment}]`，与官方 `read_image` 一致（`@deepseek-ai/dsh-tool-fs` 的 `imageReadContent`）。附件服务不可用时自动降级为只给路径。
- **窗口截图**：`PrintWindow` + `PW_RENDERFULLCONTENT`。被遮挡、非前台、比屏幕还大的窗口都能截；最小化窗口拿不到内容（DWM 不渲染），`restore=true` 时用 `SW_SHOWNOACTIVATE` 临时显示 → 截图 → 再最小化，全程不抢焦点，窗口会可见约 0.4 秒。
- **DPI**：目标窗口是 DPI 不感知的老程序时，按它的 DPI 缩放级别修正位图尺寸，避免右下角出现大片留白。

## 已知限制

- 仅 Windows（依赖 user32 / GDI+ / .NET Framework 4.x）。
- 没有 `csc.exe` 时退到 PowerShell 兜底：只有整屏能力，每次约 1.5 秒。
- 硬件加速视频、全屏独占游戏、DRM 保护内容、部分 UWP 应用可能截到黑图。
- 锁屏、UAC 提权弹窗期间截不到真实桌面。
- 跨虚拟桌面（Windows 多桌面）的窗口行为未验证。

## 安装

profile 里按普通 bundle 安装（`link:` 指向本目录），宿主会读 `package.json` 的 `dsh.bundle.patch`：

```bash
# 方式一：插件管理器（推荐，热应用）
#   在 DSH 里执行 plugin_manager install_bundle target=link:<本目录绝对路径>

# 方式二：写进 profile 依赖后装
#   "dsh-purewhite-toolkit": "link:D:/Document/deepseek-harness/default-workspace/dsh-turn-chime/plugins/dsh-purewhite-toolkit"
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
