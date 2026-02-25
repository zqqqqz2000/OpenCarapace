# OpenCarapace

Language: [English](./README.md) | **简体中文**

基于 Bun 的 Channel-first 代码 Agent 编排层。

## 测试范围说明

- 已完成端到端验证：`Codex` agent + `Telegram` channel。
- 尚未完整验证：`Claude Code` 以及桥接渠道（`Slack` / `Discord` / `WeChat`）。

## 用法（仅 Channel 方案）

### 1. 安装并初始化配置

```bash
bun install
bun run opencarapace config init
bun run opencarapace config tui
```

### 2. 配置 Codex + Telegram

编辑 `~/.config/opencarapace/config.toml`：

```toml
[runtime]
default_agent_id = "codex"
gateway_port = 3010

[agents.codex]
enabled = true
cli_command = "codex"
cli_args = ["exec", "{{prompt}}"]

[channels.telegram]
enabled = true
token_file = "~/.secrets/telegram.token"
allowed_chat_ids = ["12345"]
```

### 3. 启动渠道网关

```bash
bun run opencarapace gateway
```

### 4. 在 Telegram 使用

- 在 Telegram 对话中发消息触发 Codex。
- 常用命令：`/help`、`/status`、`/new`、`/model`、`/depth`、`/sandbox`。
- Telegram 附件会下载到本地临时目录，并注入到 prompt 上下文。

## 渠道模式

- `telegram`（原生）：推荐，且已验证。
- `slack` / `discord` / `wechat`（bridge webhook 模式）：代码可用，但不在当前验证范围内。

## 备注

- 运行配置读取 `config.toml`。
- 会话状态默认持久化到 `sessions.json`（可配置）。
