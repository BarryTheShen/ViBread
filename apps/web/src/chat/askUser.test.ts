import { Chat } from "@ai-sdk/react";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import type { MissionDetail } from "@vibread/core";
import type { UIMessage } from "ai";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MissionShellValue } from "../contracts.js";
import { askUserOf } from "./AskUserCard.js";
import { MissionThread } from "./MissionChat.js";
import { MissionShellContext } from "./missionShell.js";
import { createMissionTransport } from "./missionTransport.js";

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

const DETAIL = {
  mission: { id: "m1", title: "Dish washer", brief: "Make me a dish washer that has 4 modes", phase: "CLARIFY", inventory: [{ module: "led", count: 4 }] },
  consoles: [],
  pendingApprovals: [],
  agentBusy: false,
} as unknown as MissionDetail;

const SHELL: MissionShellValue = { missionId: "m1", detail: DETAIL, panel: { open: false, view: "schematic" }, openPanel: () => undefined, closePanel: () => undefined };

/** The mission thread exactly as the page renders it, for the chat's current messages. */
function renderThread(chat: Chat<UIMessage>): string {
  const thread = createElement(MissionThread, {
    chat,
    history: chat.messages,
    reloadHistory: async () => undefined,
    detail: DETAIL,
    events: [],
    canChat: true,
    inputRef: createRef<HTMLTextAreaElement>(),
  });
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(MemoryRouter, null, createElement(MissionShellContext.Provider, { value: SHELL }, thread))),
  );
}

function missionChat(messages: UIMessage[] = []): Chat<UIMessage> {
  return new Chat<UIMessage>({ id: "m1", transport: createMissionTransport("m1"), messages });
}

function expectQuestionCard(html: string) {
  expect(html.match(/data-ask-user/g)).toHaveLength(1);
  expect(html).toContain(QUESTION);
  for (const choice of CHOICES) expect(html).toContain(`>${choice}</button>`);
  expect(html).toContain('aria-label="Your answer"');
  expect(html).not.toContain("writing a question");
}

afterEach(() => vi.unstubAllGlobals());

describe("first streamed ask_user card (issue #2)", () => {
  for (const [name, chunks] of [
    ["valid question", VALID],
    ["question the tool schema rejected", REJECTED],
  ] as const) {
    it(`shows the question, every choice and a free-text answer right away (${name})`, async () => {
      vi.stubGlobal("fetch", async () => sse(chunks));
      const chat = missionChat();
      await chat.sendMessage({ text: "Make me a dish washer that has 4 modes" });
      expectQuestionCard(renderThread(chat));
    });
  }

  it("keeps one card with the same question after a refresh (saved history) and a resumed stream of the same run", async () => {
    const saved: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Make me a dish washer that has 4 modes" }] },
      { id: "a1", role: "assistant", parts: [{ type: "tool-ask_user", toolCallId: "c1", state: "output-error", input: INPUT, errorText: "Invalid input" }] },
    ];
    const chat = missionChat(saved);
    expectQuestionCard(renderThread(chat));

    vi.stubGlobal("fetch", async () => sse(REJECTED));
    await chat.resumeStream();
    expect(chat.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expectQuestionCard(renderThread(chat));
  });
});

describe("askUserOf", () => {
  it("shows the server's shortened display copy once the call finished, and the raw input while it streams", () => {
    const raw = { question: "A very long question about the dish washer's modes, in more words than fit?", choices: ["Eco mode for light loads", "Normal"] };
    const display = { summary: "Which modes?", question: "Which modes?", choices: ["Eco", "Normal"] };
    expect(askUserOf(raw, display)).toEqual({ question: "Which modes?", choices: ["Eco", "Normal"] });
    expect(askUserOf(raw)).toEqual(raw);
    expect(askUserOf({ question: "Which" })).toEqual({ question: "Which", choices: [] });
  });
});
