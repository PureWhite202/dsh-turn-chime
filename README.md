# dsh-turn-chime

自用插件。

给 DSH 加提示音：一轮活干完了响一声，模型反过来问你问题时另响一声，两个音分开。
宿主侧插件，监听 `session/event`，不用改 DSH 本体。

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

内置两个音效，`1.wav` 下行、`2.wav` 上行，全部由 `scripts/make-sounds.py` 合成，和 Windows
自带提示音没有关系。也可以直接指向任意音频文件；音效文件不存在时宁可不响，没有退回系统音的
兜底，只在日志里留一行警告。

安装、配置、换音效和卸载的完整说明见 [INSTALL.md](INSTALL.md)。
