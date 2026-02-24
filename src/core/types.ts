export type AgentId = "codex" | "cloudcode" | "claude-code" | (string & {});

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChannelCommandName = "notify" | "progress" | "ask_user" | (string & {});

export type TurnStatusPhase =
  | "queued"
  | "running"
  | "thinking"
  | "tooling"
  | "finalizing"
  | "completed";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};

export type AgentCommand = {
  name: ChannelCommandName;
  payload: Record<string, unknown>;
};

export type AgentEventBase = {
  at: number;
};

export type AgentStatusEvent = AgentEventBase & {
  type: "status";
  phase: TurnStatusPhase;
  message: string;
};

export type AgentDeltaEvent = AgentEventBase & {
  type: "delta";
  text: string;
};

export type AgentResultEvent = AgentEventBase & {
  type: "result";
  text: string;
};

export type AgentErrorEvent = AgentEventBase & {
  type: "error";
  error: string;
};

export type AgentCommandEvent = AgentEventBase & {
  type: "command";
  command: AgentCommand;
};

export type AgentEvent =
  | AgentStatusEvent
  | AgentDeltaEvent
  | AgentResultEvent
  | AgentErrorEvent
  | AgentCommandEvent;

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

export type AppliedSkillDescriptor = {
  id: string;
  description: string;
};

export type AgentTurnRequest = {
  agentId: AgentId;
  sessionId: string;
  prompt: string;
  messages: ChatMessage[];
  systemDirectives: string[];
  skills: AppliedSkillDescriptor[];
  limits?: {
    maxOutputChars?: number;
  };
  metadata?: Record<string, unknown>;
};

export type AgentTurnResult = {
  finalText: string;
  raw?: unknown;
};

export type ChatTurnParams = {
  agentId?: AgentId;
  sessionId: string;
  input: string;
  metadata?: Record<string, unknown>;
};

export type ChatTurnResult = {
  agentId: AgentId;
  sessionId: string;
  finalText: string;
  events: AgentEvent[];
};

export type TurnPatch = {
  systemDirectives?: string[];
  metadata?: Record<string, unknown>;
};
