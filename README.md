# OpenCarapace

轻量的多 Code Agent 编排层（Bun runtime + Bun 包管理），提供：

- 多 Agent 抽象（Codex / CloudCode / Claude Code）
- SDK / CLI / Hook 三种后端封装机制
- Skill 注入体系（含 Memory Skill）
- OpenClaw `SKILL.md` 生态接入（按问题动态匹配注入）
- Channel-first 网关（Telegram + Slack/Discord/WeChat bridge）
- Telegram 图片入站（下载到临时目录并把本地路径注入 Codex prompt）
- Telegram `/command` 自动补全（`setMyCommands`）
- 运行中 steer：新非命令输入会打断当前任务并切换到最新输入
- 运行中并行命令：`/command` 类消息可与当前任务并行执行
- `/command` 会话控制（如 `/status`、`/agent`、`/memory`）
- 轻量工具命令（`/tools`、`/grep`、`/skill`）
- 运行中通知事件（`notify` / `progress` / `ask_user`）
- 可读性策略（限制最终输出长度与结构）
- Codex 原生多轮会话（首轮 `exec`，后续 `exec resume`，`/new` 重建会话）
- 配置中心（`~/.config/opencarapace/config.toml`）
- 单元 / 集成 / E2E 测试（当前重点覆盖 Codex）

## 使用 Bun

```bash
bun install
bun test
bun run opencarapace config init
bun run opencarapace config tui
bun run opencarapace chat demo "帮我给一个发布计划" --agent codex
bun run opencarapace chat demo "/status"
bun run opencarapace serve
bun run opencarapace gateway
```

## CLI 子命令

```bash
opencarapace chat <sessionId> <message> [--agent <agentId>]
opencarapace serve
opencarapace gateway
opencarapace config path
opencarapace config init
opencarapace config show
opencarapace config set <dot.path> <value>
opencarapace config tui
opencarapace config wizard
```

说明：

- 所有运行配置只来自 `config.toml`（不读取环境变量）
- 可通过 `--config /path/to/config.toml` 指定自定义配置文件
- `config tui|wizard` 是分区向导（Runtime/Agents、Channels、Skills），可多次进入修改

服务启动后：

- `GET /health`
- `POST /chat`

示例：

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H 'content-type: application/json' \
  -d '{"agentId":"codex","sessionId":"demo","input":"给我一份简短发布计划"}'
```

也可以不传 `agentId`（使用 session 绑定或默认 `codex`）：

```bash
curl -X POST http://127.0.0.1:3000/chat \
  -H 'content-type: application/json' \
  -d '{"sessionId":"demo","input":"/help"}'
```

## 注入命名规范（Skills / Hooks）

- ID 统一使用：`vendor.scope.capability[.variant]`
- 分段规则：`.` 分隔，3-6 段，全部小写
- 每段正则：`[a-z][a-z0-9-]*`
- 在 `SkillRuntime.register()` / `HookBus.register()` 强校验并拒绝重复 ID

## 配置文件

默认路径：`~/.config/opencarapace/config.toml`  
可用命令生成默认配置：

```bash
bun run opencarapace config init
```

示例（节选）：

```toml
[runtime]
default_agent_id = "codex"
session_store_file = "sessions.json"
port = 3000
gateway_port = 3010

[agents.codex]
enabled = true
cli_command = "codex"
cli_args = ["exec", "{{prompt}}"]

[agents.cloudcode]
enabled = false
# 启用后必须提供真实命令
# cli_command = "cloudcode"
# cli_args = ["run", "{{prompt}}"]

[agents.claude_code]
enabled = false
# 启用后必须提供真实命令
# cli_command = "claude"
# cli_args = ["-p", "{{prompt}}"]

[channels.telegram]
enabled = true
token_file = "~/.secrets/telegram.token"
allowed_chat_ids = ["12345"]

[channels.slack]
enabled = true
inbound_secret_file = "~/.secrets/slack.inbound.secret"
outbound_webhook_url = "https://example.com/webhook"

[skills]
enable_openclaw_catalog = true
openclaw_root = "/Users/zzzz/Documents/openclaw"
```

敏感信息分离：

- `token_file` / `inbound_secret_file` / `outbound_webhook_url_file` 支持外部文件
- 也支持内联 `@file:/path/to/secret.txt` 或 `file:///path/to/secret.txt`
- agent 参数也支持 `cli_args_file`（按行或 CSV）

注意：

- `cloudcode` 和 `claude-code` 不再提供 mock 输出
- 如果把它们 `enabled=true`，必须配置对应 `cli_command`（否则启动时报错）
- 会话（含 `codex_thread_id`、history、model/depth/sandbox 偏好）默认持久化到 `sessions.json`
  - 默认相对 `config.toml` 所在目录
  - 可通过 `runtime.session_store_file` 指定绝对或相对路径

## Channel Gateway（无 UI）

`gateway` 进程直接对接社交通讯渠道，用户不需要 Web UI。

### Telegram（真实可用）

在 `config.toml` 启用并配置 token/token_file 后：

```bash
bun run opencarapace gateway
```

命令补全（Telegram 原生 channel）：

- 启动时会调用 Telegram `setMyCommands`
- 用户在聊天框输入 `/` 可直接看到可用命令（如 `help`/`new`/`model`/`depth`/`sandbox`）
- 当任务运行中：
  - 新的非命令消息会触发 steer（中断当前任务并切换到最新输入）
  - `/` 命令消息会并行执行，不阻塞当前任务

附件消息处理（Telegram 原生 channel）：

- 支持用户发送 `photo`、`voice`、`audio`、`document`、`video`、`video_note`、`animation`、`sticker`（可带 caption）
- 网关会调用 Telegram `getFile`，将附件下载到本地临时目录：
  - `${TMPDIR}/opencarapace/telegram-media`（例如 `/tmp/opencarapace/telegram-media`）
- 下载后的本地路径会写入本轮请求 metadata（`attachmentPaths`，并兼容保留 `imagePaths`）
- Codex adapter 会把这些本地路径附加进用户 prompt，便于 agent 在同一轮读取附件上下文
- 若附件下载失败，文本消息仍会继续处理（失败信息放入 metadata）

### 其他渠道（Bridge 方式）

内置 bridge 适配器：`slack`、`discord`、`wechat`。  
启用后通过统一 HTTP inbound 注入消息，outbound 走你配置的 webhook。

`bridge` 模式含义：

- 不是直接在你进程里跑 Slack/Discord/WeChat 原生 SDK/RTM 长连接
- 而是由上游网关把文本消息桥接到 `POST /channels/:id/inbound`
- OpenCarapace 只负责会话编排和文本回复回推
- 当前桥接渠道（Slack/Discord/WeChat）聚焦文本消息；媒体/语音/文件暂未启用
- Telegram 原生渠道已支持附件入站并注入本地附件路径到 Codex prompt

示例（Slack）：

在 `config.toml` 的 `[channels.slack]` 中配置并启用后即可。

inbound endpoint:

- `POST /channels/slack/inbound`
- `POST /channels/discord/inbound`
- `POST /channels/wechat/inbound`

header:

- `X-Channel-Secret: <secret>` 或 `Authorization: Bearer <secret>`

body:

```json
{
  "chatId": "room-123",
  "senderId": "u-1",
  "senderName": "alice",
  "messageId": "m-88",
  "threadId": "t-9",
  "text": "请给我一个发布计划"
}
```

## OpenClaw Skills 生态接入

通过 `config.toml` 配置：

- `skills.openclaw_root`
- `skills.openclaw_skill_dirs`

系统会按用户问题匹配最相关的技能片段注入。  
可用命令查看目录：

- `/skills catalog`
- `/skills catalog 50`

也支持轻量工具命令（无需 embedding）：

- `/tools`：查看可用工具
- `/grep "<pattern>" [--path <dir-or-file>] [--limit <n>]`：grep/rg 搜索
- `/skill [keywords]`：按关键词匹配技能
- `/skill show <skill-id>`：查看技能摘要与片段

常用会话命令补充：

- `/new`：清空当前会话并清除当前 Codex thread 绑定（下一轮会新建）
- `/model <name|clear>`：设置或清除当前会话的模型偏好
- `/depth <low|medium|high|clear>`：设置或清除当前会话的思考深度偏好
- `/sandbox <read-only|workspace-write|danger-full-access|clear>`：设置或清除当前会话的 Codex sandbox

## Docker

```bash
docker build -t open-carapace:dev .
docker run --rm -p 3010:3010 \
  -v ~/.config/opencarapace/config.toml:/root/.config/opencarapace/config.toml:ro \
  open-carapace:dev
```

## 可选真实 Codex E2E

默认 E2E 使用内置 Deterministic Codex backend。若要跑真实 Codex CLI：

```bash
export E2E_REAL_CODEX=1
export CODEX_CLI_COMMAND=codex
export CODEX_CLI_ARGS='exec {{prompt}}'
bun test test/e2e/codex-real.e2e.test.ts
```

> 其他 agent（CloudCode / Claude Code）已完成真实 CLI 抽象接线；启用时请配置对应可执行命令。
