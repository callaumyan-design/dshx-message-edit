# AGENTS.md

本仓库由多个 AI 编程助手（Claude Code、Codex、Jules）轮流在云端开发。
任何一个 agent 都可能因为额度用完而中途停止，然后换另一个接手。以下规则对所有 agent 都适用。

## 开始任务前

1. 先读 `HANDOFF.md`，了解当前目标、进度和下一步。
2. 如果任务来自 GitHub issue 或 PR，读完整个讨论串，再看最近的提交记录（`git log -n 20`）。
3. 如果 `HANDOFF.md` 和本次任务描述有冲突，以任务描述为准，并在交接记录里写明。

## 工作中

- **小步提交**：每完成一个能独立运行的小改动，就 commit 并 push，不要攒到最后。额度随时可能用完，没推送的改动会全部丢失。
- commit message 写清楚改了什么、为什么改。
- 不要无故重写或回滚其他 agent 写的代码。确实需要改的话，在 `HANDOFF.md` 的「决策记录」里写明理由。
- 需求不明确时，不要自己猜着做大改动。把问题写进 `HANDOFF.md` 的「待确认」，等人来决定。

## 结束前（必须做）

1. 按文件里的模板更新 `HANDOFF.md`。只保留当前有效的信息，过时的内容直接删掉。
2. commit 并 push。
3. 在对应的 PR 或 issue 里留一条简短评论，写明做了什么、还剩什么、建议的下一步。

## 语言

- PR 描述、评论和交接记录用中文。
- 代码注释、文档和 commit message 沿用仓库现有的语言习惯。

## 项目信息

- 功能：在 DSH 会话里编辑发过的提示词并重新生成，或者编辑 AI 的回复，界面风格接近 ChatGPT 网页版。
- 这是一个 DeepSeek Harness（DSH）插件。插件运行时依赖由 DSH 提供，仓库里没有 `node_modules`，平时也不需要 `npm install`。
- 版本号在 `package.json`；`cordis.patch.yml` 是 DSH 打包补丁，`dsh` 字段里是市场与客户端注入配置，改动前先读 README。
- 主要文件：`index.js`、`client.js`；安装：`node install-message-edit.mjs`
- 测试：仓库里没有自动测试；改动后至少运行 `node --check index.js && node --check client.js`，并在 PR 里写明没有实测。
