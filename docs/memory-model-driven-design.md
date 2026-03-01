# OpenCarapace Memory Design V2 (File-Only, Directory-Driven)

## 1. Goal

在 OpenCarapace 里统一为这条原则：

- 记忆是文件（source of truth），
- skill 是规则（告诉模型何时读写、读写哪些层级），
- 记忆由 LLM 通过 skill 主动读写，
- 不提供 memory 专用工具，
- 不把 `/new` `/reset` 绑定到 memory 管理。

## 2. Core Decisions

- 宿主不再做每轮自动 memory 检索和写回。
- 宿主只注入两类协议指令：
  - `skill 目录加载协议`
  - `文件记忆读写协议`
- 模型通过现有文件能力（读/写/搜索）按需访问 memory 文件。

## 3. Directory Layout

```text
.opencarapace/
  skills/
    <skill_name>/SKILL.md
  memory/
    global/
      core/
        profile.md
        preferences.md
        principles.md
      daily/
        2026-03-01.md
    projects/
      <project_id>/
        core/
          preferences.md
          decisions.md
          knowledge.md
        daily/
          2026-03-01.md
```

默认全局目录也可放在 `~/.config/opencarapace/memory/global`。

## 4. Config Schema

```toml
[skills]
paths = [".opencarapace/skills"]
load_mode = "lazy"             # lazy|eager
reload = "on_change"           # on_change|always

[memory]
enabled = true
mode = "project"               # off|project|global|hybrid
project_root = ".opencarapace/memory/projects"
global_root = "~/.config/opencarapace/memory/global"
```

## 5. Skill Injection Contract

每轮只注入协议，不注入 memory 内容本身：

- `core.skills.directory.protocol`
  - 指定 skill 根目录与加载模式。
  - 规则：先扫描 `SKILL.md` 摘要，再按任务按需读取全文。
- `core.memory.file.protocol`
  - 声明 memory 目录、作用域和分层（`core + daily`）。
  - 规则：
    - 记忆是文件，由 LLM 通过 skill 主动读写。
    - 需要历史时先读目录，再读 `core`，必要时读 `daily`。
    - 写入时稳定信息写 `core`，过程性上下文写 `daily`。
    - 只写稳定、可复用、已确认信息；不写临时猜测。

## 6. Read/Write Semantics

- Read：
  - 模型在需要历史偏好、既往决策、项目事实时主动读 memory 文件。
  - 优先读取 `core`；仅在需要近期上下文时读取 `daily`。
- Write：
  - 模型在信息“可复用且稳定”时写入 `core`。
  - 会话过程性信息（短期上下文、当天进展）写入 `daily`。
- Scope：
  - `off`: 不读不写
  - `project`: 仅项目目录
  - `global`: 仅全局目录
  - `hybrid`: 读取 `project + global`，默认写 `project`

## 7. Responsibility Matrix

- `ChatOrchestrator`：负责回合生命周期与 skill 执行时机。
- `SkillRuntime`：负责合并协议类 `systemDirectives`。
- 宿主：只提供规则和路径，不直接管理 memory 内容。
- 模型：决定读写时机与目标文件。

## 8. Rollout Plan

### Phase 1

- 启用目录协议注入（skills + memory）。

### Phase 2

- 提供模板目录初始化（skill/memory skeleton）。
- 增加最小校验（目录不存在时给出提示，不中断对话）。

### Phase 3

- 再评估是否需要索引或自动化，但保持“文件优先、工具可选”原则。
