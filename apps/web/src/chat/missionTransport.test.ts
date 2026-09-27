import { Chat } from "@ai-sdk/react";
import { QueryClient } from "@tanstack/react-query";
import type { MissionDetail, MissionSummary } from "@vibread/core";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../api/hooks.js";
import { createMissionTransport } from "./missionTransport.js";

/**
 * QA3 IQA3-15(8): after answering Claude's question the header ("Claude is working… · Stop") and the sidebar
 * ("Designing…") took ~3 s to notice, because both read `agentBusy` from polled queries. Sending must mark the mission
 * busy before the server answers, and put it back if the send fails.
 */

const detail = (agentBusy: boolean) => ({ mission: { id: "m1" }, consoles: [], pendingApprovals: [], agentBusy }) as unknown as MissionDetail;
const summary = (id: string): MissionSummary => ({ id, title: id, brief: id, phase: "CLARIFY", createdAt: "", updatedAt: "" }) as MissionSummary;

const question: UIMessage = {
  id: "a1",
  role: "assistant",
  parts: [{ type: "tool-ask_user", toolCallId: "t1", state: "output-available", input: { question: "Which colour?", choices: ["Red", "Blue"] }, output: { question: "Which colour?" } }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.mission("m1"), detail(false));
  queryClient.setQueryData(queryKeys.missions, [summary("m1"), summary("m2")]);
  const server = deferred<Response>();
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => server.promise);
  vi.stubGlobal("fetch", fetchMock);
  const chat = new Chat<UIMessage>({ id: "m1", transport: createMissionTransport("m1", queryClient), messages: [question] });
  const busy = () => ({
    header: queryClient.getQueryData<MissionDetail>(queryKeys.mission("m1"))?.agentBusy,
    sidebar: queryClient.getQueryData<MissionSummary[]>(queryKeys.missions)?.map((m) => m.agentBusy === true),
  });
  return { queryClient, server, fetchMock, chat, busy };
}

afterEach(() => vi.unstubAllGlobals());

describe("answering Claude's question", () => {
  it("shows the mission busy before the server has answered, even over a poll that left before the answer", async () => {
    const { queryClient, fetchMock, chat, busy } = setup();
    // The 4 s mission poll went out just before the click; it returns the pre-answer "not busy" after the send.
    const stalePoll = deferred<MissionDetail>();
    const polling = queryClient.fetchQuery({ queryKey: queryKeys.mission("m1"), queryFn: () => stalePoll.promise }).catch(() => undefined);

    void chat.sendMessage({ text: "Blue" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    stalePoll.resolve(detail(false));
    await polling;

    expect(busy()).toEqual({ header: true, sidebar: [true, false] });
  });

  it("puts the flag back and shows the reason when the server refuses the answer", async () => {
    const { server, fetchMock, chat, busy } = setup();
    void chat.sendMessage({ text: "Blue" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(busy().header).toBe(true);

    server.resolve(Response.json({ error: { code: "agent_busy", message: "busy" } }, { status: 409 }));
    await vi.waitFor(() => expect(chat.status).toBe("error"));
    expect(busy()).toEqual({ header: false, sidebar: [false, false] });
    expect(chat.error?.message).toMatch(/already working on this mission/);
  });
});
