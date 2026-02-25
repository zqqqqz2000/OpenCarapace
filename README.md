# OpenCarapace

Language: **English** | [简体中文](./README.zh-CN.md)

Channel-first orchestration for code agents on Bun.

## Tested Scope

- End-to-end tested: `Codex` agent + `Telegram` channel.
- Not fully verified yet: `CloudCode`, `Claude Code`, and bridge channels (`Slack` / `Discord` / `WeChat`).

## Channel Usage (Recommended)

### 1. Install and initialize config

```bash
bun install
bun run opencarapace config init
bun run opencarapace config tui
```

### 2. Configure Codex + Telegram

Edit `~/.config/opencarapace/config.toml`:

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

### 3. Start the channel gateway

```bash
bun run opencarapace gateway
```

### 4. Use Telegram as the client

- Send message in Telegram chat to trigger Codex.
- Core commands: `/help`, `/status`, `/new`, `/model`, `/depth`, `/sandbox`.
- Telegram attachments are downloaded to local temp storage and injected into prompt context.

## Channel Modes

- `telegram` (native): recommended and tested.
- `slack` / `discord` / `wechat` (bridge webhook mode): available, but not in the tested scope above.

## Notes

- Runtime config is loaded from `config.toml`.
- Session state persists to `sessions.json` (configurable).
