import { describe, expect, it } from "vitest";
import type { DeviceLine } from "@vibread/core";
import { BenchAskBridge, type AskFetch } from "./askBridge.js";

const ask: Extract<DeviceLine, { t: "ask" }> = {
  t: "ask",
  id: "led2",
  test: "led.sequence",
  kind: "which-led",
  part: "LED2",
  choices: ["1", "2", "none"],
  timeoutMs: 20_000,
};
const prompt = { title: "Light 2 of 4: Watch the blinking light", body: "Which light is blinking?", choices: [{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "none", label: "None" }] };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("BenchAskBridge", () => {
  it("publishes, reads a remote iMessage answer, and closes a local answer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: AskFetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST" && url.endsWith("/bench/asks")) return response({ ok: true }, 201);
      if (init?.method === "POST" && url.endsWith("/close")) return response({ ok: true }, 201);
      return response({ status: "answered", answer: "2", answeredBy: { name: "Barry", channel: "imessage" } });
    };
    const bridge = new BenchAskBridge("mission-1", fetcher);

    await bridge.publish(ask, prompt);
    const remote = await bridge.poll(ask.id);
    await bridge.close("btn0-press", "done");

    expect(remote).toMatchObject({ status: "answered", answer: "2", answeredBy: { name: "Barry", channel: "imessage" } });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ askId: "led2", test: "led.sequence", kind: "which-led", part: "LED2", choices: ["1", "2", "none"] });
    expect(calls.at(-1)?.url).toContain("/bench/asks/btn0-press/close");
  });
});
