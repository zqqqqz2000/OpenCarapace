# OpenCarapace Unified Memory Design

> Note: This document describes the legacy host-managed memory flow (pre-fetch in `beforeTurn`, write-back in `afterTurn`).
> For the current file-only, directory-driven design (skill protocol injection + model decides when to read/write files), see:
> [memory-model-driven-design.md](./memory-model-driven-design.md)

## 1. Goals

- Reuse OpenClaw-like memory ideas (file + retrieval + flexible scope), but fit OpenCarapace's adapter model (Codex/Claude CLI, not direct LLM tool-calling API).
- Let user choose memory behavior with clear switches:
  - on/off
  - project-scoped
  - global-scoped
  - optional hybrid
- Keep agent-agnostic: memory retrieval and injection happen in orchestrator skills, not in provider-specific logic.

## 2. Constraints

- Current memory is in-process (`InMemoryMemoryBank`) and session-only.
- Current adapters receive plain prompt + system directives; no unified tool-call contract for all agents.
- Session metadata already supports global/workspace/session layered config (`SessionManager.getMetadata()`), which can host runtime overrides.

## 3. Proposed Scope Model

Use one top-level mode to avoid ambiguous toggles.

- `off`: disable memory completely.
- `project`: memory isolated by project key.
- `global`: one shared memory pool for all projects/sessions (project switch ignored).
- `hybrid` (optional, advanced): read from both project+global; write policy configurable.

This directly covers your requirement: when mode is `global`, project-level switches are ignored by design.

## 4. Config Schema (new)

```toml
[memory]
enabled = true                 # master switch
mode = "project"               # off|project|global|hybrid
backend = "builtin"            # builtin|qmd (future)
max_hits = 3
max_user_chars = 300
max_assistant_chars = 300
min_token_len = 2

[memory.storage]
file = "~/.config/opencarapace/memory.json"   # single store, all scopes

[memory.project]
default_enabled = true         # only used when mode=project|hybrid

[memory.hybrid]
read_order = ["project", "global"]
write_target = "project"       # project|global|both
global_weight = 0.3
project_weight = 0.7

[memory.retrieval]
algorithm = "lexical"          # lexical|hybrid (future)
```

Optional runtime override (existing metadata layers):

- global metadata key: `memory_mode_override`
- workspace metadata key: `memory_enabled_override`

Priority:

1. runtime override (session/workspace/global metadata)
2. config file
3. defaults

## 5. Project Identity Resolution

Add `MemoryScopeResolver`:

1. parse from channel session id (`agent.<projectKey>...`) if available
2. else from session metadata (`project_root_dir` hash or explicit `project_key`)
3. else `"default"`

This keeps scope stable across channels and local CLI sessions.

## 6. Architecture

- `MemoryStore` (interface)
  - `append(entry)`
  - `search(query, scope, limit)`
  - `dump(scope, limit)`
  - `clear(scope)`
  - `status()`
- `FileMemoryStore` (phase 1)
  - persisted JSON file with file lock pattern similar to session store
  - record includes `scopeType` (`global|project`), `scopeKey`, `sessionId`, `agentId`, `at`, `userText`, `assistantText`
- `MemoryRetrievalEngine`
  - phase 1: lexical overlap + recency
  - phase 2: hybrid/vector (optional backend plugin, qmd-like)
- `UnifiedMemorySkill` (replace current `MemorySkill`)
  - `beforeTurn`: resolve effective mode + scope, search hits, inject compact directives
  - `afterTurn`: write memory according to write policy

## 7. Responsibility Matrix (who does what)

- `ChatOrchestrator`
  - owns turn lifecycle.
  - triggers skill hooks in order:
    - `skills.runBeforeTurn(...)` before adapter call.
    - `skills.runAfterTurn(...)` after adapter result is finalized.
- `SkillRuntime`
  - executes all applicable skills.
  - merges `TurnPatch.systemDirectives` from skills.
- `UnifiedMemorySkill` (memory orchestrator inside skill layer)
  - read path (`beforeTurn`):
    - resolves effective mode/scope via `MemoryScopeResolver`.
    - calls `MemoryRetrievalEngine.search(...)`.
    - returns memory directives as `TurnPatch.systemDirectives`.
  - write path (`afterTurn`):
    - extracts current turn user/assistant summary.
    - decides target scope via mode/write policy.
    - persists through `MemoryStore.append(...)`.
- `AgentAdapter` (`CodexAgentAdapter` / `ClaudeCodeAgentAdapter`)
  - does not implement memory logic.
  - only receives merged `systemDirectives` and forwards/composes prompt.
- `ConversationCommandService` (`/memory ...`)
  - operational control surface:
    - inspect, clear, switch mode (if enabled).
  - does not participate in normal read/write hook timing.

## 8. Turn Sequence (read/inject/write timing)

### 8.1 Retrieval + injection (before model call)

1. user input arrives at `ChatOrchestrator.chatUnsafe`.
2. orchestrator builds base request (`prompt/messages/systemDirectives=[]`).
3. orchestrator calls `skills.runBeforeTurn`.
4. `UnifiedMemorySkill.beforeTurn` runs:
   - resolve effective memory mode.
   - if mode is `off`, return nothing.
   - else query `MemoryRetrievalEngine`.
   - format hits into compact memory directives.
5. `SkillRuntime` merges patches.
6. adapter receives merged directives and calls underlying agent CLI.

### 8.2 Write-back (after model result)

1. adapter returns final text.
2. orchestrator normalizes readability and appends assistant message to session.
3. orchestrator calls `skills.runAfterTurn`.
4. `UnifiedMemorySkill.afterTurn` runs:
   - extract latest user message + assistant final text.
   - truncate and normalize.
   - choose target scope (`project/global/both`) based on mode.
   - persist via `MemoryStore`.

### 8.3 Ownership summary

- memory read/retrieval owner: `UnifiedMemorySkill` (via `MemoryRetrievalEngine`).
- memory injection owner: `UnifiedMemorySkill` (returns directives), merged by `SkillRuntime`.
- memory write owner: `UnifiedMemorySkill.afterTurn`.
- timing owner: `ChatOrchestrator` (decides before/after hook boundaries).

## 9. Injection Contract (agent-agnostic)

Continue to inject via `systemDirectives` only.

Format:

```text
Memory Context (use only if directly relevant):
1. [scope=project:myproj] user: ...
   assistant: ...
```

Rationale: works for Codex CLI and Claude CLI uniformly, no provider-specific tool API dependency.

## 10. Failure Handling / Guardrails

- retrieval failure:
  - do not fail the user turn.
  - memory skill returns empty patch and logs warning.
- write failure:
  - do not fail the user turn.
  - emit warn log + metric; skip memory append for that turn.
- storage lock contention:
  - bounded retry with timeout, same pattern as session store locking.
- scope mismatch:
  - fallback to `project:default` unless mode is `global`.
- directive budget:
  - hard cap by `max_hits` and char budget to prevent prompt bloat.

## 11. Command UX

Extend `/memory`:

- `/memory status`
- `/memory show [n] [project|global|effective]`
- `/memory clear [project|global|effective]`
- `/memory mode [off|project|global|hybrid]` (writes metadata override or config via explicit flag)

Help text should explain:

- `global` mode ignores project toggles.
- `project` mode isolates by project key.

## 12. Compatibility & Migration

- If old `InMemoryMemoryBank` data exists, no strict migration required (ephemeral).
- On first run of new system:
  - create memory file automatically
  - fallback to empty memory if file read fails
- Keep old command output shape where possible (`Memory (latest n)`).

## 13. Phased Implementation Plan

### Phase A (safe baseline)

- Add config types + defaults for `memory`.
- Implement `MemoryScopeResolver`.
- Implement `FileMemoryStore` with lexical retrieval only.
- Swap in `UnifiedMemorySkill` preserving current `/memory show|clear`.

### Phase B (scope UX)

- Add `/memory status` + `/memory mode`.
- Add per-scope clear/show.
- Add tests for mode precedence and project/global behavior.

### Phase C (flexibility upgrades)

- Add `hybrid` mode read/write policy.
- Add backend plug point (`backend=builtin|qmd`).
- Optional: index workspace `MEMORY.md` + `memory/*.md` as additional sources.

## 14. Test Matrix

- unit:
  - scope resolution
  - mode precedence
  - retrieval ranking
  - write policy per mode
- integration:
  - memory survives process restart (file-backed)
  - project isolation in `project` mode
  - cross-project sharing in `global` mode
  - `global` mode ignores project toggle
- command tests:
  - `/memory mode ...`
  - `/memory show ...` and `/memory clear ...`

## 15. Why This Is Better Than "single global switch only"

- It gives a simple default (`project`) and a strict shared option (`global`).
- It keeps future room (`hybrid`) without forcing complexity now.
- It remains adapter-agnostic and does not assume model-native function calling.
