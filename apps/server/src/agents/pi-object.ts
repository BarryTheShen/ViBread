import { Type, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ClaudeCallOptions, ClaudeModel } from "./models.js";

/**
 * One structured Claude answer (test author, RETRO, photo check, scan): the answer schema is offered as the only tool and
 * Claude is required to call it; its arguments are the answer, checked by the zod schema.
 */
export async function completeObject<T>(
  claude: ClaudeModel,
  input: {
    system: string;
    content: string | (TextContent | ImageContent)[];
    schema: z.ZodType<T>;
    name: string;
    description?: string;
  } & Pick<ClaudeCallOptions, "effort" | "signal">,
): Promise<T> {
  const tool = {
    name: input.name,
    description: input.description ?? `Return the ${input.name.replace(/_/g, " ")}.`,
    parameters: Type.Unsafe(z.toJSONSchema(input.schema, { io: "input", target: "draft-7", unrepresentable: "any" })),
  };
  const reply = await claude.complete(
    { systemPrompt: input.system, messages: [{ role: "user", content: input.content, timestamp: Date.now() }], tools: [tool] },
    { toolChoice: { type: "tool", name: input.name }, ...(input.effort ? { effort: input.effort } : {}), ...(input.signal ? { signal: input.signal } : {}) },
  );
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `Claude's ${input.name} request ${reply.stopReason === "aborted" ? "was stopped" : "failed"}.`);
  const call = reply.content.find((part) => part.type === "toolCall" && part.name === input.name);
  if (call?.type !== "toolCall") throw new Error(`Claude answered without a ${input.name}.`);
  return input.schema.parse(call.arguments);
}
