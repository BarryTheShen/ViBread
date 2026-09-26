import type { ChatMessage } from "@mui/x-chat/types";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { approvalMetaOf, approvalResponse, decisionOf, normalizeChunks, rememberToolCalls, toChatMessages, toUserUiMessage, type ToolCallRegistry } from "./uiMessages.js";

async function collect<T>(input: T[], transform: TransformStream<T, T>): Promise<T[]> {
  const out: T[] = [];
  const reader = new ReadableStream<T>({
    start(controller) {
      for (const item of input) controller.enqueue(item);
      controller.close();
    },
  })
    .pipeThrough(transform)
    .getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe("toChatMessages", () => {
  it("maps AI SDK tool parts (incl. approval ids and states) to MUI X Chat tool invocations", () => {
    const history: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Make a moon lamp" }] },
      {
        id: "a1",
        role: "assistant",
        metadata: { vibread: { approvals: {} } },
        parts: [
          { type: "step-start" },
          { type: "text", text: "Checking…", state: "done" },
          { type: "tool-run_erc", toolCallId: "c1", state: "output-available", input: { revision: 1 }, output: { summary: "No problems" } },
          {
            type: "tool-release_revision",
            toolCallId: "c2",
            state: "approval-requested",
            input: { revision: 1 },
            approval: { id: "ap-9" },
          },
          {
            type: "tool-propose_design",
            toolCallId: "c3",
            state: "output-denied",
            input: {},
            approval: { id: "ap-3", approved: false, reason: "deny" },
          },
          { type: "dynamic-tool", toolName: "ask_user", toolCallId: "c4", state: "output-error", input: {}, errorText: "boom" },
          { type: "data-progress", id: "p1", data: { pct: 50 } },
        ],
      },
    ];
    const [user, assistant] = toChatMessages(history, "m1");
    expect(user).toMatchObject({ id: "u1", role: "user", conversationId: "m1", parts: [{ type: "text", text: "Make a moon lamp" }] });
    expect(assistant.metadata).toEqual({ vibread: { approvals: {} } });
    expect(assistant.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "Checking…", state: "done" },
      {
        type: "tool",
        toolInvocation: expect.objectContaining({ toolName: "run_erc", toolCallId: "c1", state: "output-available", output: { summary: "No problems" } }),
      },
      {
        type: "tool",
        toolInvocation: expect.objectContaining({ toolName: "release_revision", state: "approval-requested", approvalId: "ap-9", approval: undefined }),
      },
      {
        type: "tool",
        toolInvocation: expect.objectContaining({ state: "output-denied", approvalId: "ap-3", approval: { approved: false, reason: "deny" } }),
      },
      { type: "dynamic-tool", toolInvocation: expect.objectContaining({ toolName: "ask_user", state: "output-error", errorText: "boom" }) },
      { type: "data-progress", id: "p1", data: { pct: 50 } },
    ]);
  });
});

describe("toUserUiMessage", () => {
  it("keeps only the text/file parts the server accepts from the browser", () => {
    const message: ChatMessage = {
      id: "u2",
      role: "user",
      parts: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "never sent" },
        { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AA", filename: "b.jpg" },
      ],
    };
    expect(toUserUiMessage(message)).toEqual({
      id: "u2",
      role: "user",
      parts: [
        { type: "text", text: "hello" },
        { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AA", filename: "b.jpg" },
      ],
    });
  });
});

describe("approval decisions", () => {
  it("round-trips all three decisions through MUI X Chat's approved/reason pair", () => {
    for (const decision of ["approve-once", "approve-mission", "deny"] as const) {
      expect(decisionOf(approvalResponse("ap", decision))).toBe(decision);
    }
    expect(decisionOf({ approved: true })).toBe("approve-once");
    expect(decisionOf({ approved: false, reason: "approve-mission" })).toBe("deny");
  });

  it("reads approval card copy from message metadata and rejects incomplete entries", () => {
    const meta = {
      vibread: {
        approvals: {
          a: { summary: "Release r2", consequence: "Build uses r2", actionClass: "release", revisionHash: "abc", expiresAt: "2026-09-26T10:00:00Z" },
          b: { summary: "No consequence" },
        },
      },
    };
    expect(approvalMetaOf(meta, "a")).toEqual({
      summary: "Release r2",
      consequence: "Build uses r2",
      actionClass: "release",
      revisionHash: "abc",
      expiresAt: "2026-09-26T10:00:00Z",
    });
    expect(approvalMetaOf(meta, "b")).toBeUndefined();
    expect(approvalMetaOf(undefined, "a")).toBeUndefined();
  });
});

describe("normalizeChunks", () => {
  it("renames AI SDK messageMetadata to metadata and accumulates approval copy across chunks", async () => {
    type Chunk = { type: string; [k: string]: unknown };
    const out = await collect<Chunk>(
      [
        { type: "start", messageId: "a1" },
        { type: "message-metadata", messageMetadata: { vibread: { approvals: { x: { summary: "X" } } } } },
        { type: "message-metadata", messageMetadata: { vibread: { approvals: { y: { summary: "Y" } } }, other: 1 } },
        { type: "text-delta", id: "t", delta: "hi" },
      ],
      normalizeChunks<Chunk>(),
    );
    expect(out[0]).toEqual({ type: "start", messageId: "a1" });
    expect(out[1].metadata).toEqual({ vibread: { approvals: { x: { summary: "X" } } } });
    expect(out[2].metadata).toEqual({ vibread: { approvals: { x: { summary: "X" }, y: { summary: "Y" } } }, other: 1 });
    expect(out[3]).toEqual({ type: "text-delta", id: "t", delta: "hi" });
  });
});

describe("normalizeChunks tool names", () => {
  type Chunk = { type: string; [k: string]: unknown };

  it("fills the name and input MUI X Chat would overwrite from an approval request that carries only ids", async () => {
    const out = await collect<Chunk>(
      [
        { type: "tool-input-available", toolCallId: "c1", toolName: "release_revision", input: { revision: 2 } },
        { type: "tool-approval-request", toolCallId: "c1", approvalId: "ap-1" },
        { type: "tool-output-available", toolCallId: "c1", output: { summary: "ok" } },
      ],
      normalizeChunks<Chunk>(),
    );
    expect(out[1]).toEqual({ type: "tool-approval-request", toolCallId: "c1", approvalId: "ap-1", toolName: "release_revision", input: { revision: 2 } });
    expect(out[2]).toEqual({ type: "tool-output-available", toolCallId: "c1", output: { summary: "ok" } });
  });

  it("names a call that starts mid-stream after a reconnect from the loaded history part with the same toolCallId", async () => {
    const registry: ToolCallRegistry = new Map();
    const history: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "tool-release_revision", toolCallId: "c7", state: "approval-requested", input: { revision: 3 }, approval: { id: "ap-7" } }],
      },
    ];
    rememberToolCalls(toChatMessages(history, "m1"), registry);
    const [resumed] = await collect<Chunk>([{ type: "tool-approval-request", toolCallId: "c7", approvalId: "ap-7" }], normalizeChunks<Chunk>(registry));
    expect(resumed).toMatchObject({ toolName: "release_revision", input: { revision: 3 } });
  });
});
