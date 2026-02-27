import type { AgentEvent, AgentTurnRequest, ChatTurnResult, TurnPatch } from "./types";
import { assertInjectableId } from "./naming";

export type HookBeforeTurnContext = {
  request: AgentTurnRequest;
};

export type HookAfterTurnContext = {
  request: AgentTurnRequest;
  result: ChatTurnResult;
};

export type HookEventContext = {
  request: AgentTurnRequest;
  event: AgentEvent;
};

export type HookHandler = {
  id: string;
  beforeTurn?: (context: HookBeforeTurnContext) => Promise<TurnPatch | void> | TurnPatch | void;
  afterTurn?: (context: HookAfterTurnContext) => Promise<void> | void;
  onEvent?: (context: HookEventContext) => Promise<void> | void;
};

export class HookBus {
  private readonly hooks: HookHandler[] = [];
  private readonly hookIds = new Set<string>();

  register(hook: HookHandler): void {
    assertInjectableId("hook", hook.id);
    if (this.hookIds.has(hook.id)) {
      throw new Error(`duplicate hook id: ${hook.id}`);
    }
    this.hooks.push(hook);
    this.hookIds.add(hook.id);
  }

  async runBeforeTurn(context: HookBeforeTurnContext): Promise<TurnPatch> {
    const merged: TurnPatch = {
      systemDirectives: [],
      metadata: {},
    };

    for (const hook of this.hooks) {
      if (!hook.beforeTurn) {
        continue;
      }
      const patch = await hook.beforeTurn(context);
      if (!patch) {
        continue;
      }
      if (patch.systemDirectives?.length) {
        merged.systemDirectives?.push(...patch.systemDirectives);
      }
      if (patch.metadata) {
        Object.assign(merged.metadata ?? {}, patch.metadata);
      }
    }

    return merged;
  }

  async runAfterTurn(context: HookAfterTurnContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.afterTurn) {
        continue;
      }
      await hook.afterTurn(context);
    }
  }

  async runOnEvent(context: HookEventContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onEvent) {
        continue;
      }
      await hook.onEvent(context);
    }
  }
}
