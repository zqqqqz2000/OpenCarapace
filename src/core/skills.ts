import type {
  AgentEvent,
  AgentId,
  AgentTurnRequest,
  AppliedSkillDescriptor,
  ChatTurnResult,
  TurnPatch,
} from "./types";
import { assertInjectableId } from "./naming";

export type SkillBeforeTurnContext = {
  request: AgentTurnRequest;
};

export type SkillAfterTurnContext = {
  request: AgentTurnRequest;
  result: ChatTurnResult;
};

export type SkillOnEventContext = {
  request: AgentTurnRequest;
  event: AgentEvent;
};

export interface Skill {
  readonly id: string;
  readonly description: string;
  readonly appliesTo: AgentId[] | "*" | undefined;
  beforeTurn?: (context: SkillBeforeTurnContext) => Promise<TurnPatch | void> | TurnPatch | void;
  afterTurn?: (context: SkillAfterTurnContext) => Promise<void> | void;
  onEvent?: (context: SkillOnEventContext) => Promise<void> | void;
}

export function appliesToAgent(skill: Skill, agentId: AgentId): boolean {
  if (!skill.appliesTo || skill.appliesTo === "*") {
    return true;
  }
  return skill.appliesTo.includes(agentId);
}

export class SkillRuntime {
  private readonly skills: Skill[] = [];
  private readonly skillIds = new Set<string>();

  register(skill: Skill): void {
    assertInjectableId("skill", skill.id);
    if (this.skillIds.has(skill.id)) {
      throw new Error(`duplicate skill id: ${skill.id}`);
    }
    this.skills.push(skill);
    this.skillIds.add(skill.id);
  }

  listApplicable(agentId: AgentId): Skill[] {
    return this.skills.filter((skill) => appliesToAgent(skill, agentId));
  }

  listAll(): Skill[] {
    return [...this.skills];
  }

  describe(skills: Skill[]): AppliedSkillDescriptor[] {
    return skills.map((skill) => ({ id: skill.id, description: skill.description }));
  }

  async runBeforeTurn(skills: Skill[], request: AgentTurnRequest): Promise<TurnPatch> {
    const merged: TurnPatch = {
      systemDirectives: [],
      metadata: {},
    };

    for (const skill of skills) {
      if (!skill.beforeTurn) {
        continue;
      }
      const patch = await skill.beforeTurn({ request });
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

  async runAfterTurn(skills: Skill[], request: AgentTurnRequest, result: ChatTurnResult): Promise<void> {
    for (const skill of skills) {
      if (!skill.afterTurn) {
        continue;
      }
      await skill.afterTurn({ request, result });
    }
  }

  async runOnEvent(skills: Skill[], request: AgentTurnRequest, event: AgentEvent): Promise<void> {
    for (const skill of skills) {
      if (!skill.onEvent) {
        continue;
      }
      await skill.onEvent({ request, event });
    }
  }
}

export class InstructionSkill implements Skill {
  readonly id: string;
  readonly description: string;
  readonly appliesTo: AgentId[] | "*" | undefined;

  constructor(params: {
    id: string;
    description: string;
    instruction: string;
    appliesTo?: AgentId[] | "*";
  }) {
    this.id = params.id;
    this.description = params.description;
    this.appliesTo = params.appliesTo;
    this.instruction = params.instruction;
  }

  private readonly instruction: string;

  beforeTurn(): TurnPatch {
    return {
      systemDirectives: [this.instruction],
    };
  }
}
