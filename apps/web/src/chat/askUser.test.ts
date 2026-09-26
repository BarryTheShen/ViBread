import { ChatStore } from "@mui/x-chat-headless/store";
import { processStream } from "@mui/x-chat-headless/stream";
import type { ChatMessage } from "@mui/x-chat/types";
import type { UIMessage } from "ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskUserCard } from "./AskUserCard.js";
import { createMissionChatAdapter } from "./missionAdapter.js";

/**
 * GitHub issue #2: the first ask_user card showed "Claude has a question for you" without the question or choices.
 * The chunks below are exactly what apps/server/src/agents/runs.ts streams (AI SDK toUIMessageStream, captured from
 * streamText with the server's ask_user tool): input streamed as deltas, then `tool-input-available` — or, when Claude's
 * question doesn't fit the tool schema (more than 6 choices, a choice over 80 characters), `tool-input-error` carrying
 * the same input. The run then stops (stopWhen hasToolCall("ask_user")).
 */
const QUESTION = "Which 4 modes should the dish washer have?";
const CHOICES = ["Eco", "Normal", "Heavy", "Quick", "Rinse", "Delicate", "Let me type my own"];
const INPUT = { question: QUESTION, choices: CHOICES };
const RAW = JSON.stringify(INPUT);

const head = [
  { type: "start", messageId: "a1" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "A dish washer with 4 modes — one question first." },
  { type: "text-end", id: "t1" },
  { type: "tool-input-start", toolCallId: "c1", toolName: "ask_user" },
  { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: RAW.slice(0, 20) },
  { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: RAW.slice(20) },
];
const tail = [{ type: "finish-step" }, { type: "finish", finishReason: "tool-calls" }];
const VALID = [
  ...head,
  { type: "tool-input-available", toolCallId: "c1", toolName: "ask_user", input: INPUT },
  { type: "tool-output-available", toolCallId: "c1", output: { summary: QUESTION, ...INPUT } },
  ...tail,
];
const REJECTED = [
  ...head,
  { type: "tool-input-error", toolCallId: "c1", toolName: "ask_user", input: INPUT, errorText: "Invalid input for tool ask_user" },
  { type: "tool-output-error", toolCallId: "c1", errorText: "Invalid input for tool ask_user" },
  ...tail,
];

function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

const USER: ChatMessage = { id: "u1", conversationId: "m1", role: "user", parts: [{ type: "text", text: "Make me a dish washer that has 4 modes" }] };

/** Sends the brief through the mission adapter against a server that answers with `chunks`; returns the chat state. */
async function firstTurn(chunks: unknown[]): Promise<ChatStore> {
  vi.stubGlobal("fetch", async () => sse(chunks));
  const adapter = createMissionChatAdapter("m1");
  const store = new ChatStore({ initialActiveConversationId: "m1" });
  const stream = await adapter.sendMessage({ conversationId: "m1", message: USER, messages: [USER], signal: new AbortController().signal });
  await processStream(store, stream, { conversationId: "m1" });
  return store;
}

function askUserInput(store: ChatStore): unknown {
  const parts = Object.values(store.state.messagesById).flatMap((m) => m.parts);
  const tool = parts.find((p) => (p.type === "tool" || p.type === "dynamic-tool") && p.toolInvocation.toolName === "ask_user");
  return tool && (tool.type === "tool" || tool.type === "dynamic-tool") ? tool.toolInvocation.input : undefined;
}

function renderCard(input: unknown): string {
  return renderToStaticMarkup(createElement(AskUserCard, { input, answerable: true, onAnswer: () => undefined }));
}

afterEach(() => vi.unstubAllGlobals());

describe("first streamed ask_user card (issue #2)", () => {
  for (const [name, chunks] of [
    ["valid question", VALID],
    ["question the tool schema rejected", REJECTED],
  ] as const) {
    it(`shows the question, every choice and a free-text answer right away (${name})`, async () => {
      const html = renderCard(askUserInput(await firstTurn(chunks)));
      expect(html).toContain(QUESTION);
      for (const choice of CHOICES) expect(html).toContain(`>${choice}</button>`);
      expect(html).toContain('aria-label="Your answer"');
      expect(html).not.toContain("writing a question");
    });
  }

  it("keeps one card with the same question after a refresh (GET chat) and a resumed stream of the same run", async () => {
    const saved: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Make me a dish washer that has 4 modes" }] },
      { id: "a1", role: "assistant", parts: [{ type: "tool-ask_user", toolCallId: "c1", state: "output-error", input: INPUT, errorText: "Invalid input" }] },
    ];
    let call = 0;
    vi.stubGlobal("fetch", async () => (call++ === 0 ? new Response(JSON.stringify(saved)) : sse(REJECTED)));
    const adapter = createMissionChatAdapter("m1");
    const store = new ChatStore({ initialActiveConversationId: "m1" });
    const history = await adapter.listMessages?.({ conversationId: "m1" });
    store.setMessages(history?.messages ?? []);
    expect(renderCard(askUserInput(store))).toContain(QUESTION);

    const resumed = await adapter.reconnectToStream?.({ conversationId: "m1", signal: new AbortController().signal });
    if (!resumed) throw new Error("expected the active run's stream");
    await processStream(store, resumed, { conversationId: "m1" });
    const cards = Object.values(store.state.messagesById).flatMap((m) => m.parts.filter((p) => p.type === "tool" || p.type === "dynamic-tool"));
    expect(cards).toHaveLength(1);
    expect(renderCard(askUserInput(store))).toContain(QUESTION);
  });
});
