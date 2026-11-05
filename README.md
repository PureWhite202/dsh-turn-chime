# dsh-turn-chime

给 DSH 加提示音：一轮活干完了响一声，模型反过来问你问题时另响一声，两个音分开。
宿主侧插件，监听 `session/event`，不用改 DSH 本体。

音效全部由 `scripts/make-sounds.py` 合成，和 Windows 自带提示音没有关系。代码里也没有
任何退回系统音的路径：音效文件不存在时宁可不响，只在日志里留一行警告。

## 它什么时候响

**结束音**（`1`，下行）：

- 一轮对话正常结束（`completed`）
- 出错、被拦、撞到 token 上限、被中断（`error` / `blocked` / `max-tokens` / `interrupted`）

**提问音**（`2`，上行）：

- 模型调用 `ask_user_question`，弹出问题卡片等你回答
- 模型在计划模式下调用 `exit_plan_mode`，弹出计划评审等你批准

不响的情况：用户自己按了取消（`aborted`）、fork 出来的会话（`forked`）、子代理会话
（`session.header.origin === 'subagent'`）、以及同一类 800ms 内的重复事件。
结束音和提问音各自计时，互不吞音：先提问、紧接着结束，两声都会响。

## 音效

| 名字 | 文件 | 用在哪 | 听感 |
| --- | --- | --- | --- |
| `1`（默认） | `1.wav` | 结束音 | G6→E6→C6→G5 四连音木琴下琶音，短促、带木质敲击声 |
| `2`（默认提问音） | `2.wav` | 提问音 | 同一套音色的逐音镜像：G5→C6→E6→G6 上行，像同一把琴往上划 |

两者是同一段音高序列的正反两版，音色、间隔、每个音的时长和响度一一对应，所以一听就能分出「往上」还是「往下」。

也可以直接写任意音频文件的路径（绝对路径最稳）：wav 走 SoundPlayer（起播快，音量跟系统），
mp3/m4a/ogg 等走 Windows Media Player（起播慢约 1 秒，但 `volume` 生效）。
想自己捏音色就编辑 `scripts/make-sounds.py` 再跑一次（需要 numpy）。

### 用别人的音效

把下载的一堆候选丢进一个文件夹（比如仓库根目录下的 `sfx\`），逐个试听：

```powershell
powershell -ExecutionPolicy Bypass -File tools\audition.ps1 -Path '.\sfx'
```

它会按文件名顺序播放，播之前打印 `[序号/总数] 文件名`。听到中意的，把路径抄进配置：

```yaml
config:
  sound: '.\sfx\中意的那个.wav'
```

相对路径按当前工作目录解析，拿不准就直接写绝对路径，两种都认。

## 安装

profile 目录 `~/.dsh/profiles/desktop`，两处改动：

1. 把仓库放到 `~/.dsh/plugins/dsh-turn-chime`（克隆或直接搬过去都行）；
   `package.json` 的 `dsh.profile.bundles` 里加 `"dsh-turn-chime"`，`dependencies` 加
   `"dsh-turn-chime": "link:../../plugins/dsh-turn-chime"`。
   `link:` 后面是相对 profile 目录的路径，`../../plugins/dsh-turn-chime` 正好指到
   `~/.dsh/plugins/dsh-turn-chime`；仓库放别处就照实际位置改，不用写绝对路径；
2. 在 profile 目录跑一次 `dsh plugin --profile desktop install`，然后**完全退出** DSH
   （托盘图标右键 → 退出，不是关窗口）再启动。

宿主只在启动时组装插件树，装完不重启等于没装。

## 配置

写进 profile 的 `cordis.patch.yml`（按 id 覆盖）或直接改本包的 `cordis.patch.yml`：

```yaml
- id: turn-chime
  name: dsh-turn-chime
  config:
    sound: 1          # 结束音
    askSound: 2       # 提问音
    volume: 70
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `sound` | `1` | 结束音：内置名 `1`/`2`，或任意音频文件路径 |
| `errorSound` | `null` | `error` 时改播这个；不填就用 `sound` |
| `askSound` | `2` | 提问音：内置名、路径；`false` 关闭提问音 |
| `askTools` | `['ask_user_question','exit_plan_mode']` | 哪些工具调用算「在问你」 |
| `volume` | `85` | 播放音量 0–100，只对非 wav 生效（wav 跟随系统音量） |
| `announce` | `true`（本机配置） | 插件加载后先响一次，用来确认音效；嫌吵改成 `false` |
| `reasons` | `['completed','error','blocked','max-tokens','interrupted']` | 哪些收尾原因响结束音 |
| `skipSubagents` | `true` | 子代理会话不响 |
| `debounceMs` | `800` | 去抖窗口，毫秒；结束音和提问音各自计时 |
| `debug` | `false` | 每次响之前往宿主日志写一行，带触发原因和音效路径 |
| `command` | `null` | 自定义播放命令；填了就不再走内置播放器 |

## 卸载

从 `dsh.profile.bundles` 里删掉 `dsh-turn-chime`，跑 `dsh plugin --profile desktop remove dsh-turn-chime`，重启。
