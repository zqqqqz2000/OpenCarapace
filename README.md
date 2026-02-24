# OpenCarapace

轻量的多 Code Agent 编排层（Bun runtime + Bun 包管理），提供：

- 多 Agent 抽象（Codex / CloudCode / Claude Code）
- SDK / CLI / Hook 三种后端封装机制
- Skill 注入体系（含 Memory Skill）
- `/command` 会话控制（如 `/status`、`/agent`、`/memory`）
- 运行中通知事件（`notify` / `progress` / `ask_user`）
- 可读性策略（限制最终输出长度与结构）
- 单元 / 集成 / E2E 测试（当前重点覆盖 Codex）

## 使用 Bun

```bash
bun install
bun test
bun run src/cli/chat.ts demo "帮我给一个发布计划" --agent codex
bun run src/cli/chat.ts demo "/status"
bun run src/cli/server.ts
```

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

## Docker

```bash
docker build -t open-carapace:dev .
docker run --rm -p 3000:3000 open-carapace:dev
```

## 可选真实 Codex E2E

默认 E2E 使用内置 Deterministic Codex backend。若要跑真实 Codex CLI：

```bash
export E2E_REAL_CODEX=1
export CODEX_CLI_COMMAND=codex
export CODEX_CLI_ARGS='exec {{prompt}}'
bun test test/e2e/codex-real.e2e.test.ts
```

> 其他 agent（CloudCode / Claude Code）已完成抽象与接线，当前未启用实测。
