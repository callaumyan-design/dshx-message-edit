# dshx-message-edit

在 DSH 会话里编辑你发过的提示词并重新生成，或编辑 AI 的回复。界面风格与 ChatGPT 网页版类似：

- 铅笔「编辑」按钮放在消息原生操作栏里，与「复制」「分支」并列，样式也一致；
- 编辑后直接**替换原来的显示**；
- 消息有多个版本时，铅笔旁会出现 **‹ 2/3 ›**，可以在原文和各次修改之间切换。

> 目标版本：DSH `0.2.0-rc.2`。后端用真实 `dsh-session` 测试过，前端做过加载冒烟测试。

## 用法

| 对象 | 操作 | 效果 |
|---|---|---|
| 你的提示词 | 悬停 → 操作栏里的铅笔 | 用新提示词重新生成；原提示词和其后的对话被隐藏，原位显示新提示词和新回答。用 ‹ › 切回旧版本查看 |
| AI 回复 | 回复下方操作栏里的铅笔 | 回复原地显示为修改后的文字，模型此后也读这个版本；后续对话保留。用 ‹ › 查看原文或历次修改 |

编辑框读取完整原文；`Ctrl+Enter` 保存，`Esc` 取消。

## 实现

- **按钮**：提示词的按钮通过 portal 放进原生操作行 `[data-clock="start"]`；回复的按钮走 Chat 提供的
  `conversation.chat.assistant-actions` 插槽。按钮直接复用相邻原生按钮的 class，
  因此大小、颜色、悬停效果都和原生按钮相同。
- **原地替换显示**：以更低的 priority 注册 `conversation.chat.node` 的 `user` 和 `assistant-step`
  渲染器。按插槽系统规则，priority 越低越优先渲染，所以会先渲染本插件的包装组件。
  包装组件内部仍渲染 Chat **原本的组件**，只是修改了传入的数据，所以外观不变。
  包装组件一旦出错，宿主的错误边界会自动退回原渲染器。
- **提示词版本**：撤回说明那条 `user/message`（宿主已知的事件类型）在 `source` 里带上
  `fromId` / `rpcId`，把旧提示词链接到新提示词，由此串成版本链。每个版本各开一个回合，切换时用生成的 CSS
  把其它版本对应的回合（`[data-chat-turn]`）隐藏掉。
- **模型侧**：编辑提示词时，用一次 `surfaceOp: replace` 把旧提示词以及它之后的所有节点替换成一句说明，
  然后通过 `sessionController.prompt()` 发送新提示词。
  编辑回复时，把修改写进插件自己的侧文件 `%DSH_HOME%\dshx-message-edit\overrides\<sessionId>.json`
  （未设 `DSH_HOME` 时为 `~/.dsh`），再通过 `llm/stream` waterfall 在请求发给模型前改写：
  只替换 text 块，reasoning 和 tool-call 块保留。
- `/state` 只读，不会恢复冷会话。冷会话通过 `sessionController.inspect()` 读取日志，
  所以历史版本照样可以切换。

## 为什么不再写自定义会话事件（v1.3.0）

宿主读取会话日志时，遇到不认识且没有标记 `ignorable: true` 的事件类型，会拒绝加载整个会话；
而 `session.append()` 不允许插件设置这个标记。v1.2.0 写入的 `dshx-message-edit/prompt-edit` 和
`dshx-message-edit/override` 因此会让编辑过的会话报「历史加载失败」。从 v1.3.0 起，插件只写宿主已知的事件类型。
旧日志里的这两类事件修复成 `ignorable: true` 后，旧的编辑历史仍然能读出来。

这一点用真实 `dsh-session` 0.2.0-rc.2 测试过：每次编辑后都用宿主的 `validateStoredEvents` 检查，日志都能正常加载。

## 已知限制

- 切换只改变**显示**：模型始终读取最新版本。想让模型基于旧版本继续，请再编辑一次。
- 修正提示词只保留文本，原消息里的图片等附件不会带过去。
- 卸载本插件后，会话仍能正常加载；界面退回显示原始回复，模型也读原始回复（侧文件里的修改不再生效）。
- 回复的修改存在侧文件里：只拷贝会话日志到别处时，这些修改不会跟着走。
- 正在生成时编辑提示词，会先停止当前生成。

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-message-edit
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-message-edit
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-message-edit`。

## License

MIT
