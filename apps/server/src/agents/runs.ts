import { randomUUID } from "node:crypto";
import type { Actor, ApprovalRequest, ToolRegistry } from "@vibread/core";
import { ToolInputError, createAiToolset, errorMessage, isClaudeNotConnected } from "@vibread/tools";
import {
  InvalidToolApprovalError,
  InvalidToolApprovalSignatureError,
  ToolCallNotFoundForApprovalError,
  convertToModelMessages,
  hasToolCall,
  isStepCount,
  streamText,
  tool,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";
import type { AgentDeps, MissionEvent } from "./deps.js";
import { approvalMetadata, type ApprovalLinks } from "./approval-links.js";
import type { AgentModels } from "./models.js";
import { designSystemPrompt } from "./prompts.js";

/** Upper bound on model steps per run (PLAN §5.2 `stopWhen: isStepCount(20)`). */
export const MAX_STEPS = 20;
/** Design iterations per run before the agent must report blockers (PLAN §5.4). */
export const MAX_DESIGN_ITERATIONS = 4;

export class AgentBusyError extends Error {
  readonly code = "agent_busy";
  readonly status = 409;
  constructor() {
    super("The agent is already working on this mission. Wait for it to finish or stop it.");
    this.name = "AgentBusyError";
  }
}

export interface RunOutcome {
  messages: UIMessage[];
  aborted: boolean;
  /** Text of the run's final assistant message. */
  text: string;
  /** ask_user question, when the agent is waiting for the user. */
  question?: string;
  error?: string;
}

export interface ActiveRun {
  id: string;
  missionId: string;
  /** Every UI chunk of this run so far (replayed to late subscribers). */
  chunks: UIMessageChunk[];
  done: boolean;
  controller: AbortController;
  finished: Promise<RunOutcome>;
}

export interface RunManager {
  active(missionId: string): ActiveRun | undefined;
  /**
   * The run GET /chat/stream should replay: the active run, or a run that finished within the last few seconds without
   * anyone watching it (e.g. a resume after an approval that completed before the browser reconnected).
   */
  replayable(missionId: string): ActiveRun | undefined;
  start(missionId: string, input: { message?: UIMessage; actor: Actor }): Promise<ActiveRun>;
  stop(missionId: string): boolean;
  /** Replay-from-start + live stream of a run's UI chunks. */
  stream(run: ActiveRun): ReadableStream<UIMessageChunk>;
}

const askUser = tool({
  title: "Ask you a question",
  description: "Ask the person ONE short clarifying question when the brief is ambiguous; the run stops until they answer.",
  inputSchema: z.object({
    question: z.string().min(1).max(300),
    choices: z.array(z.string().min(1).max(80)).max(6).optional(),
  }),
  execute: async ({ question, choices }) => ({ summary: question, question, ...(choices ? { choices } : {}) }),
});

function friendlyError(error: unknown): string {
  if (InvalidToolApprovalSignatureError.isInstance(error)) return "Approval rejected: its signature is missing or invalid, so nothing was run.";
  if (InvalidToolApprovalError.isInstance(error) || ToolCallNotFoundForApprovalError.isInstance(error)) return "Approval rejected: it does not match a pending action.";
  if (isClaudeNotConnected(error)) return errorMessage(error);
  return `The agent hit an error: ${errorMessage(error)}`;
}

function lastAssistant(messages: UIMessage[]): UIMessage | undefined {
  return messages.findLast((m) => m.role === "assistant");
}

interface TrackedRun extends ActiveRun {
  wake: Set<() => void>;
  error?: string;
  watched: boolean;
  finishedAt?: number;
}

/** How long a finished run nobody watched stays replayable on GET /chat/stream. */
const UNWATCHED_REPLAY_MS = 10_000;

interface PreparedRun {
  ui: ReadableStream<UIMessageChunk>;
  /** Set by onFinish once the stream has ended and history is saved. */
  outcome(): RunOutcome | undefined;
}

export function createRunManager(
  deps: AgentDeps & { models: AgentModels; tools: ToolRegistry; links: ApprovalLinks; sendMachine: (missionId: string, event: MissionEvent) => Promise<void> },
): RunManager {
  const { store, broker, messages, config, log, links } = deps;
  const runs = new Map<string, TrackedRun>();
  const unwatched = new Map<string, TrackedRun>();

  /**
   * The person wrote a new message instead of deciding: open approvals in the history are denied (broker + tool part), so
   * every tool call has a result and the model sees that the action did not run.
   */
  async function supersedeOpenApprovals(missionId: string, history: UIMessage[]): Promise<UIMessage[]> {
    const reason = "Not approved: the person replied with a new message instead.";
    const system: Actor = { kind: "system", id: "chat", name: "ViBread", channel: "system" };
    const next: UIMessage[] = [];
    for (const message of history) {
      if (message.role !== "assistant") {
        next.push(message);
        continue;
      }
      const parts: UIMessage["parts"] = [];
      for (const part of message.parts) {
        if ("state" in part && part.state === "approval-requested") {
          const link = links.resolve(part.approval.id);
          if (link) await broker.decide(link.brokerId, "deny", system).catch(() => undefined);
          parts.push({ ...part, state: "output-denied", approval: { ...part.approval, approved: false, reason } } as UIMessage["parts"][number]);
        } else parts.push(part);
      }
      next.push({ ...message, parts });
    }
    return next;
  }

  async function setup(run: TrackedRun, input: { message?: UIMessage; actor: Actor }): Promise<PreparedRun> {
    const { missionId } = run;
    const mission = await store.getMission(missionId);
    if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
    // Resolved per run: the owner may connect or disconnect their Claude account at any time.
    const { model, credential } = await deps.models.design(mission.ownerId);

    let history = await links.hydrate(missionId);
    if (input.message) {
      history = [...(await supersedeOpenApprovals(missionId, history)), input.message];
      await messages.save(missionId, history);
      const text = input.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      await store.appendEvent({ missionId, channel: input.actor.channel, actor: input.actor, kind: "message", text: text.slice(0, 2000) });
    }
    if (mission.phase === "BRIEF" || mission.phase === "CLARIFY") await deps.sendMachine(missionId, { type: "DESIGN_STARTED" });
    if (credential.kind === "claude-account") {
      await store.appendEvent({
        missionId,
        channel: "system",
        actor: { kind: "system", id: "claude-account", name: "Claude account", channel: "system" },
        kind: "agent.credential",
        text: `Using your Claude account${credential.email ? ` (${credential.email})` : ""}`,
        data: credential,
      });
    }

    // Broker requests behind approvals already in this history (resume after a decision, possibly after a restart).
    const approvals = new Map<string, ApprovalRequest>();
    for (const link of links.fromHistory(missionId, history)) {
      const request = await broker.get(link.brokerId);
      if (request) approvals.set(link.toolCallId, request);
    }
    const agentActor: Actor = { kind: "agent", id: "design-agent", name: "Design agent", channel: input.actor.channel };
    const toolset = createAiToolset({ registry: deps.tools, broker, store, ctx: { missionId, actor: agentActor }, approvals });
    const tools: ToolSet = { ...toolset.tools, ask_user: askUser };
    const names = Object.keys(tools);

    const result = streamText({
      model,
      system: designSystemPrompt({ mission, revision: await store.getRevision(missionId) }),
      messages: await convertToModelMessages(history, { tools }),
      tools,
      toolApproval: toolset.toolApproval,
      experimental_toolApprovalSecret: config.approvalSecret,
      stopWhen: [isStepCount(MAX_STEPS), hasToolCall("ask_user")],
      prepareStep: ({ steps }) => {
        const iterations = steps.flatMap((s) => s.toolCalls).filter((c) => c.toolName === "propose_design").length;
        return iterations >= MAX_DESIGN_ITERATIONS ? { activeTools: names.filter((n) => n !== "propose_design") } : {};
      },
      abortSignal: run.controller.signal,
      onError: ({ error }) => log.warn({ missionId, err: errorMessage(error) }, "design agent stream error"),
    });

    let outcome: RunOutcome | undefined;
    const ui = result.toUIMessageStream({
      originalMessages: history,
      generateMessageId: randomUUID,
      messageMetadata: ({ part }) => {
        if (part.type !== "tool-approval-request" || part.isAutomatic) return undefined;
        const request = toolset.approvals.get(part.toolCall.toolCallId);
        if (!request) return undefined;
        links.record({ approvalId: part.approvalId, brokerId: request.id, missionId, toolCallId: part.toolCall.toolCallId });
        return approvalMetadata({ approvalId: part.approvalId }, request, part.toolCall.toolCallId);
      },
      onError: (error) => {
        run.error = friendlyError(error);
        return run.error;
      },
      onFinish: async ({ messages: all, isAborted }) => {
        await messages.save(missionId, all);
        const reply = lastAssistant(all);
        const text = reply?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim() ?? "";
        const asked = reply?.parts.find((p) => p.type === "tool-ask_user" && p.state === "output-available");
        const question = asked && "input" in asked ? (asked.input as { question?: string }).question : undefined;
        outcome = { messages: all, aborted: isAborted, text, ...(question ? { question } : {}), ...(run.error ? { error: run.error } : {}) };
        if (question) await deps.sendMachine(missionId, { type: "NEEDS_CLARIFICATION" });
        if (text || question) {
          await store.appendEvent({ missionId, channel: input.actor.channel, actor: agentActor, kind: "message", text: (question ?? text).slice(0, 2000) });
        }
      },
    });
    return { ui, outcome: () => outcome };
  }

  /** Drains the UI stream into the run's replay buffer, then releases the mission and resolves `finished`. */
  async function drive(run: TrackedRun, prepared: PreparedRun, resolve: (outcome: RunOutcome) => void): Promise<void> {
    const reader = prepared.ui.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        run.chunks.push(value);
        for (const wake of run.wake) wake();
      }
    } catch (error) {
      run.error = friendlyError(error);
      log.error({ missionId: run.missionId, err: errorMessage(error) }, "design agent run failed");
    } finally {
      run.done = true;
      for (const wake of run.wake) wake();
      runs.delete(run.missionId);
      run.finishedAt = Date.now();
      if (!run.watched) unwatched.set(run.missionId, run);
    }
    const outcome = prepared.outcome() ?? {
      messages: await messages.list(run.missionId).catch(() => []),
      aborted: run.controller.signal.aborted,
      text: "",
      ...(run.error ? { error: run.error } : {}),
    };
    resolve(outcome);
  }

  return {
    active: (missionId) => runs.get(missionId),

    replayable(missionId) {
      const active = runs.get(missionId);
      if (active) return active;
      const finished = unwatched.get(missionId);
      if (finished && Date.now() - (finished.finishedAt ?? 0) <= UNWATCHED_REPLAY_MS) return finished;
      unwatched.delete(missionId);
      return undefined;
    },
    async start(missionId, input) {
      if (runs.has(missionId)) throw new AgentBusyError();
      let resolveFinished!: (outcome: RunOutcome) => void;
      const run: TrackedRun = {
        id: randomUUID(),
        missionId,
        chunks: [],
        done: false,
        controller: new AbortController(),
        finished: new Promise<RunOutcome>((resolve) => (resolveFinished = resolve)),
        wake: new Set(),
        watched: false,
      };
      runs.set(missionId, run); // reserved before the first await: two concurrent starts can't both run
      let prepared: PreparedRun;
      try {
        prepared = await setup(run, input);
      } catch (error) {
        runs.delete(missionId);
        throw error;
      }
      void drive(run, prepared, resolveFinished);
      return run;
    },

    stop(missionId) {
      const run = runs.get(missionId);
      if (!run) return false;
      run.controller.abort();
      return true;
    },

    stream(run) {
      const tracked = run as TrackedRun;
      let index = 0;
      tracked.watched = true;
      if (unwatched.get(tracked.missionId) === tracked) unwatched.delete(tracked.missionId);
      let wake: (() => void) | undefined;
      return new ReadableStream<UIMessageChunk>({
        async pull(controller) {
          while (index >= tracked.chunks.length && !tracked.done) {
            // Executor form: the repo targets lib ES2023, which has no Promise.withResolvers typing.
            await new Promise<void>((resolve) => {
              wake = resolve;
              tracked.wake.add(resolve);
            });
            if (wake) tracked.wake.delete(wake);
          }
          if (index < tracked.chunks.length) controller.enqueue(tracked.chunks[index++]!);
          else controller.close();
        },
        cancel() {
          if (wake) tracked.wake.delete(wake);
        },
      });
    },
  };
}
