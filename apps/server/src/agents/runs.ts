import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Actor, ToolRegistry } from "@vibread/core";
import { ToolInputError, errorMessage, isClaudeNotConnected } from "@vibread/tools";
import { createUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { AgentDeps, MissionEvent } from "./deps.js";
import type { AgentModels } from "./models.js";
import { ASK_USER, askUserTool, registryTools, type AskUserOutput } from "./pi-tools.js";
import { FINISH_REASONS, PiChunkTranslator, historyToPi, userContent } from "./pi-ui.js";
import { designSystemPrompt } from "./prompts.js";
import { actorForLog } from "./trace.js";

/** Upper bound on model turns per run (PLAN §5.2). */
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
   * anyone watching it (e.g. a short iMessage-started run that completed before the browser connected).
   */
  replayable(missionId: string): ActiveRun | undefined;
  start(missionId: string, input: { message: UIMessage; actor: Actor }): Promise<ActiveRun>;
  stop(missionId: string): boolean;
  /** Replay-from-start + live stream of a run's UI chunks. */
  stream(run: ActiveRun): ReadableStream<UIMessageChunk>;
}

/**
 * A model/provider failure as the person reads it in the chat. Provider errors arrive as "<status> <JSON body>"
 * (or the error type alone mid-stream); the raw text goes to the debug log, never the chat.
 */
export function friendlyModelError(raw: string): string {
  const status = /^\s*(\d{3})\b/.exec(raw)?.[1];
  const type = /"type"\s*:\s*"([a-z_]+_error)"/.exec(raw)?.[1] ?? /\b([a-z]+_error)\b/.exec(raw)?.[1];
  if (status === "401" || status === "403" || type === "authentication_error" || type === "permission_error") {
    return "Claude rejected the key or sign-in. Reconnect your Claude account in Settings (or check the server's ANTHROPIC_API_KEY), then send your message again.";
  }
  const wait = /Server requested (\d+)s retry delay/.exec(raw)?.[1];
  if (wait) return `Claude is busy right now. Try again in about ${Number(wait) >= 120 ? `${Math.ceil(Number(wait) / 60)} minutes` : `${wait} seconds`}.`;
  if (status === "429" || type === "rate_limit_error") return "Claude is busy right now (rate limit). Wait a minute, then send your message again.";
  if (/refused|refusal|sensitive/i.test(raw)) return "Claude declined to answer this request. Rephrase it and send it again.";
  if (status === "529" || type === "overloaded_error" || /overloaded/i.test(raw)) return "Claude is overloaded right now. Try again in a minute.";
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network/i.test(raw)) return "ViBread couldn't reach Claude (network problem). Check the connection and send your message again.";
  const detail = /"message"\s*:\s*"([^"]{1,200})"/.exec(raw)?.[1];
  if (status === "400" || type === "invalid_request_error") return `Claude couldn't process this request${detail ? ` (${detail})` : ""}. Try again; if it keeps happening, check Settings → Diagnostics.`;
  return "The agent hit an error talking to Claude. Try again; if it keeps happening, check Settings → Diagnostics.";
}

function friendlyError(error: unknown): string {
  if (isClaudeNotConnected(error)) return errorMessage(error);
  return friendlyModelError(errorMessage(error));
}

/** Identical read-only tool calls allowed per run; the next one is refused (the answer can't change). */
const MAX_IDENTICAL_READS = 2;

const STEP_CAP_NOTE = `I stopped after ${MAX_STEPS} steps without finishing this turn. Tell me to continue, or tell me what to change.`;

function lastAssistant(messages: UIMessage[]): UIMessage | undefined {
  return messages.findLast((m) => m.role === "assistant");
}

interface TrackedRun extends ActiveRun {
  wake: Set<() => void>;
  error?: string;
  startedAt: number;
  /** From the run's pi turns (absent when it failed before the first turn). */
  stats?: { steps: number; finish: string; usage: { input: number; output: number } };
  watched: boolean;
  finishedAt?: number;
}

/** How long a finished run nobody watched stays replayable on GET /chat/stream. */
const UNWATCHED_REPLAY_MS = 10_000;

interface PreparedRun {
  ui: ReadableStream<UIMessageChunk>;
  /** Set by onEnd once the stream has ended and history is saved. */
  outcome(): RunOutcome | undefined;
}

export function createRunManager(
  deps: AgentDeps & { models: AgentModels; tools: ToolRegistry; sendMachine: (missionId: string, event: MissionEvent) => Promise<void> },
): RunManager {
  const { store, broker, messages, log, debug } = deps;
  const runs = new Map<string, TrackedRun>();
  const unwatched = new Map<string, TrackedRun>();

  async function setup(run: TrackedRun, input: { message: UIMessage; actor: Actor }): Promise<PreparedRun> {
    const { missionId } = run;
    const mission = await store.getMission(missionId);
    if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
    const content = userContent(input.message);
    if (!content) throw new ToolInputError("Send a message with text or a photo.");
    // Resolved per run: the owner may connect or disconnect their Claude account at any time.
    const design = await deps.models.design(mission.ownerId, { missionId, purpose: "design" });

    const prior = await messages.list(missionId);
    const history = [...prior, input.message];
    await messages.save(missionId, history);
    const text = input.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    await store.appendEvent({ missionId, channel: input.actor.channel, actor: input.actor, kind: "message", text: text.slice(0, 2000) });
    if (mission.phase === "BRIEF" || mission.phase === "CLARIFY") await deps.sendMachine(missionId, { type: "DESIGN_STARTED" });
    if (design.credential.kind === "claude-account") {
      await store.appendEvent({
        missionId,
        channel: "system",
        actor: { kind: "system", id: "claude-account", name: "Claude account", channel: "system" },
        kind: "agent.credential",
        text: `Using your Claude account${design.credential.email ? ` (${design.credential.email})` : ""}`,
        data: design.credential,
      });
    }

    const agentActor: Actor = { kind: "agent", id: "design-agent", name: "Design agent", channel: input.actor.channel };
    let turns = 0;
    let proposals = 0;
    const reads = new Map<string, number>();
    // The pi transcript is rebuilt from the server-held UI history every run: that history is the only record.
    const agent = new Agent({
      initialState: {
        systemPrompt: designSystemPrompt({ mission, revision: await store.getRevision(missionId) }),
        model: design.model,
        thinkingLevel: "off",
        tools: [...registryTools({ registry: deps.tools, broker, store, ctx: { missionId, actor: agentActor } }), askUserTool],
        messages: historyToPi(prior, design.model),
      },
      streamFn: design.streamFn,
      sessionId: missionId,
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }) => {
        if (deps.tools.get(toolCall.name)?.actionClass === "read-only") {
          const signature = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
          const count = (reads.get(signature) ?? 0) + 1;
          reads.set(signature, count);
          if (count > MAX_IDENTICAL_READS) {
            return { block: true, reason: `You already called ${toolCall.name} with exactly this input ${MAX_IDENTICAL_READS} times this turn; the answer won't change. Use the result you have, try something different, or tell the person what blocks you.` };
          }
        }
        if (toolCall.name !== "propose_design") return undefined;
        if (proposals >= MAX_DESIGN_ITERATIONS) {
          return { block: true, reason: `That was design attempt ${proposals + 1}; the limit is ${MAX_DESIGN_ITERATIONS} per turn. Tell the person exactly what still blocks and what they could decide or change.` };
        }
        proposals++;
        return undefined;
      },
      finishTurn: ({ toolResults }) => {
        turns++;
        // The run waits for the person after asking; the answer arrives as their next message (a new run).
        if (toolResults.some((r) => r.toolName === ASK_USER && !r.isError)) return { action: "end" };
        return turns >= MAX_STEPS ? { action: "end" } : undefined;
      },
    });
    run.controller.signal.addEventListener("abort", () => agent.abort(), { once: true });

    let outcome: RunOutcome | undefined;
    const ui = createUIMessageStream<UIMessage>({
      originalMessages: history,
      generateId: randomUUID,
      onError: (error) => {
        run.error = friendlyError(error);
        log.error({ missionId, err: errorMessage(error) }, "design agent run failed");
        return run.error;
      },
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        const translator = new PiChunkTranslator((chunk) => writer.write(chunk));
        const replies: AssistantMessage[] = [];
        agent.subscribe((event) => {
          translator.handle(event);
          if (event.type === "message_end" && event.message.role === "assistant") replies.push(event.message);
        });
        if (!run.controller.signal.aborted) await agent.prompt({ role: "user", content, timestamp: Date.now() });
        const last = replies.at(-1);
        run.stats = {
          steps: replies.length,
          finish: last?.stopReason ?? "aborted",
          usage: { input: replies.reduce((sum, r) => sum + r.usage.input, 0), output: replies.reduce((sum, r) => sum + r.usage.output, 0) },
        };
        if (run.controller.signal.aborted || last?.stopReason === "aborted") {
          // Saved with the reply (onEnd) and seen live by anyone following the stream: the chat marks a cut-off reply.
          writer.write({ type: "message-metadata", messageMetadata: { vibread: { stopped: true } } });
          writer.write({ type: "abort" });
          return;
        }
        if (last?.stopReason === "error") {
          log.warn({ missionId, err: last.errorMessage }, "design agent model error");
          debug.event(missionId, "agent", "design run: Claude returned an error", { runId: run.id, error: last.errorMessage ?? "unknown" }, "error");
          run.error = friendlyError(new Error(last.errorMessage ?? "the model request failed"));
          writer.write({ type: "error", errorText: run.error });
        } else if (last?.stopReason === "toolUse" && turns >= MAX_STEPS) {
          // The step cap ended the turn mid-work: say so instead of stopping silently.
          run.stats.finish = "step-cap";
          writer.write({ type: "text-start", id: "step-cap" });
          writer.write({ type: "text-delta", id: "step-cap", delta: STEP_CAP_NOTE });
          writer.write({ type: "text-end", id: "step-cap" });
        } else if (last?.stopReason === "length") {
          writer.write({ type: "text-start", id: "length" });
          writer.write({ type: "text-delta", id: "length", delta: "My reply was cut off at Claude's output limit. Tell me to continue." });
          writer.write({ type: "text-end", id: "length" });
        }
        writer.write({ type: "finish", finishReason: last ? FINISH_REASONS[last.stopReason] : "other" });
      },
      onEnd: async ({ messages: all, isAborted }) => {
        await messages.save(missionId, all);
        const reply = lastAssistant(all);
        const text = reply?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim() ?? "";
        const asked = reply?.parts.find((p) => p.type === `tool-${ASK_USER}` && p.state === "output-available");
        const question = asked && "output" in asked ? (asked.output as AskUserOutput | undefined)?.question : undefined;
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
    const toolCalls = lastAssistant(outcome.messages)?.parts.flatMap((p) => (p.type.startsWith("tool-") ? [p.type.slice(5)] : [])) ?? [];
    const result = outcome.error ? "error" : outcome.aborted ? "aborted" : outcome.question ? "asked" : "done";
    debug.event(
      run.missionId,
      "agent",
      `design run ${result} in ${((Date.now() - run.startedAt) / 1000).toFixed(1)}s`,
      { runId: run.id, ms: Date.now() - run.startedAt, outcome: result, ...(run.stats ?? {}), toolCalls, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.question ? { question: outcome.question } : {}) },
      outcome.error ? "error" : "info",
    );
    resolve(outcome);
  }

  /**
   * A run that couldn't start (Claude not connected, credential broken) still leaves the person's message and the reason in
   * the chat history and on the timeline, so a reload shows what happened.
   */
  async function recordFailedStart(missionId: string, input: { message: UIMessage; actor: Actor }, reason: string): Promise<void> {
    const prior = await messages.list(missionId);
    const withMessage = prior.some((m) => m.id === input.message.id) ? prior : [...prior, input.message];
    const reply: UIMessage = { id: randomUUID(), role: "assistant", parts: [{ type: "text", text: reason }], metadata: { vibread: { error: true } } };
    await messages.save(missionId, [...withMessage, reply]);
    const text = input.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (text) await store.appendEvent({ missionId, channel: input.actor.channel, actor: input.actor, kind: "message", text: text.slice(0, 2000) });
    await store.appendEvent({ missionId, channel: "system", actor: { kind: "system", id: "design-agent", name: "Design agent", channel: "system" }, kind: "agent.error", text: reason.slice(0, 2000) });
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
        startedAt: Date.now(),
      };
      runs.set(missionId, run); // reserved before the first await: two concurrent starts can't both run
      let prepared: PreparedRun;
      try {
        prepared = await setup(run, input);
      } catch (error) {
        runs.delete(missionId);
        debug.event(missionId, "agent", `design run couldn't start: ${errorMessage(error)}`.slice(0, 300), { runId: run.id, actor: actorForLog(input.actor), error: errorMessage(error) }, "warn");
        if (!(error instanceof ToolInputError)) await recordFailedStart(missionId, input, friendlyError(error)).catch((cause: unknown) => log.warn({ missionId, err: errorMessage(cause) }, "couldn't record the failed start"));
        throw error;
      }
      debug.event(missionId, "agent", `design run started by ${input.actor.kind} ${input.actor.id} (${input.actor.channel})`, { runId: run.id, actor: actorForLog(input.actor) });
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
