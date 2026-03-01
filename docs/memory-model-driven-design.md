# OpenCarapace Memory Design V2 (File-Only, Directory-Driven)

## 1. Goal

在 OpenCarapace 里统一为这条原则：

- 记忆是文件（source of truth），
- skill 是规则（告诉模型何时读写、读写哪些层级），
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
      profile.md
      preferences.md
      principles.md
    projects/
      <project_id>/
        index.md
        context.md
        decisions/
        knowledge/
        runbooks/
        tasks/
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
legacy_session_skill = false   # 兼容旧 /memory show|clear
```

## 5. Skill Injection Contract

每轮只注入协议，不注入 memory 内容本身：

- `core.skills.directory.protocol`
  - 指定 skill 根目录与加载模式。
  - 规则：先扫描 `SKILL.md` 摘要，再按任务按需读取全文。
- `core.memory.file.protocol`
  - 声明 memory 目录、作用域和写入标准。
  - 规则：只写稳定、可复用、已确认信息；不写临时猜测。

## 6. Read/Write Semantics

- Read：
  - 模型在需要历史偏好、既往决策、项目事实时主动读 memory 文件。
- Write：
  - 模型在信息“可复用且稳定”时写入对应分层目录。
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

## 8. Legacy Compatibility

- 旧 `MemorySkill`（会话内内存）保留为兼容路径。
- 仅当 `memory.legacy_session_skill = true` 时启用 `/memory show|clear`。
- 默认关闭，避免与新方案冲突。

## 9. Rollout Plan

### Phase 1

- 启用目录协议注入（skills + memory）。
- 默认关闭 legacy session memory。

### Phase 2

- 提供模板目录初始化（skill/memory skeleton）。
- 增加最小校验（目录不存在时给出提示，不中断对话）。

### Phase 3

- 再评估是否需要索引或自动化，但保持“文件优先、工具可选”原则。
