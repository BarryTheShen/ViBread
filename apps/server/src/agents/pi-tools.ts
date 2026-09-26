import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ApprovalBroker, MissionStore, ToolContext, ToolDef, ToolRegistry } from "@vibread/core";
import { invokeTool } from "@vibread/tools";
import { z } from "zod";

/** The design agent's clarifying-question tool; the run ends after the turn that calls it (runs.ts). */
export const ASK_USER = "ask_user";

/** Display caps for ask_user: over-long input is shortened for the card, never rejected (GitHub issue #2). */
const ASK_LIMITS = { question: 1000, choices: 10, choice: 160 } as const;

/** What the model reads back after asking: the answer comes as the person's next chat message. */
const ASK_USER_RESULT = "The question is shown to the person. Stop now; their answer arrives as their next message.";

export interface AskUserOutput {
  summary: string;
  question: string;
  choices?: string[];
}

/** The text a tool result shows the model. Live runs and history replays (pi-ui.ts) must agree on it. */
export function toolResultText(toolName: string, output: unknown): string {
  if (toolName === ASK_USER) return ASK_USER_RESULT;
  return JSON.stringify(output ?? null);
}

/** Registry zod schema → the JSON Schema pi validates arguments against and sends to the model. */
function parametersOf(def: ToolDef): TSchema {
  return Type.Unsafe(z.toJSONSchema(def.input, { io: "input", target: "draft-7", unrepresentable: "any" }));
}

function result(toolName: string, output: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: toolResultText(toolName, output) }], details: output };
}

/**
 * The registry as pi AgentTools. There are no approvals: every tool runs when the agent calls it, except physical tools,
 * which never run here — the call only files a bench request that waits for a click at the bench (invokeTool). Invalid
 * arguments and tool refusals throw, and pi hands the message back to the model as an error tool result.
 */
export function registryTools(input: {
  registry: ToolRegistry;
  broker: ApprovalBroker;
  store: MissionStore;
  ctx: Pick<ToolContext, "missionId" | "actor">;
}): AgentTool[] {
  const { registry, broker, store, ctx } = input;
  return registry.list().map(
    (def): AgentTool => ({
      name: def.name,
      label: def.title,
      description: def.description,
      parameters: parametersOf(def),
      // Design tools change the mission (revisions, parts): one at a time, in the order the model asked.
      executionMode: "sequential",
      async execute(_toolCallId, args, signal) {
        const outcome = await invokeTool({ registry, broker, store, ctx: { ...ctx, ...(signal ? { signal } : {}) }, name: def.name, args });
        if (outcome.status === "executed") return result(def.name, outcome.output);
        return result(def.name, { ...(outcome.output as Record<string, unknown>), status: "waiting-for-bench-click", approvalId: outcome.approval.id });
      },
    }),
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** ask_user: accepts any question/choices the model writes and shortens them for display. */
export const askUserTool: AgentTool = {
  name: ASK_USER,
  label: "Ask you a question",
  description:
    "Ask the person ONE short clarifying question when the brief is ambiguous; offer up to 6 short choices when you can. The run stops until they answer.",
  parameters: Type.Object({
    question: Type.String({ minLength: 1, description: "One short question in plain words." }),
    choices: Type.Optional(Type.Array(Type.String(), { description: "Up to 6 short answers the person can pick." })),
  }),
  async execute(_toolCallId, args) {
    const { question, choices } = args as { question: string; choices?: string[] };
    const shown = choices?.filter((c) => c.trim()).slice(0, ASK_LIMITS.choices).map((c) => clip(c, ASK_LIMITS.choice));
    const text = clip(question, ASK_LIMITS.question);
    const output: AskUserOutput = { summary: text, question: text, ...(shown?.length ? { choices: shown } : {}) };
    return result(ASK_USER, output);
  },
};
