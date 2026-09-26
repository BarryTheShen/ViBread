import type { DeviceLine } from "@vibread/core";

export interface AskPrompt {
  title: string;
  body: string;
  choices: { value: string; label: string }[];
}

export interface RemoteAskStatus {
  status: "open" | "answered" | "closed";
  answer?: string;
  answeredBy?: { name?: string; channel?: string };
}

export type AskFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Fire-and-forget CAPCOM/iMessage ask publication and first-answer operations. */
export class BenchAskBridge {
  private readonly base: string;
  private readonly fetcher: AskFetch;

  constructor(missionId: string, fetcher: AskFetch = fetch) {
    this.base = `/api/missions/${encodeURIComponent(missionId)}/bench/asks`;
    this.fetcher = fetcher;
  }

  async publish(ask: Extract<DeviceLine, { t: "ask" }>, prompt: AskPrompt): Promise<void> {
    const response = await this.fetcher(this.base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        askId: ask.id,
        test: ask.test,
        kind: ask.kind,
        ...(ask.part === undefined ? {} : { part: ask.part }),
        prompt: prompt.body,
        choices: prompt.choices.map((choice) => choice.value),
        timeoutMs: ask.timeoutMs,
      }),
    });
    if (!response.ok) throw new Error(`Could not publish the prompt (${response.status}).`);
  }

  async poll(askId: string): Promise<RemoteAskStatus> {
    const response = await this.fetcher(`${this.base}/${encodeURIComponent(askId)}`);
    if (!response.ok) throw new Error(`Could not check the prompt (${response.status}).`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("status" in body)) throw new Error("The prompt status was malformed.");
    const status = body.status;
    if (status !== "open" && status !== "answered" && status !== "closed") throw new Error("The prompt status was invalid.");
    const answer = "answer" in body && typeof body.answer === "string" ? body.answer : undefined;
    const answeredBy = "answeredBy" in body && typeof body.answeredBy === "object" && body.answeredBy !== null
      ? body.answeredBy as { name?: string; channel?: string }
      : undefined;
    return { status, answer, answeredBy };
  }

  async close(askId: string, answer?: string): Promise<void> {
    const response = await this.fetcher(`${this.base}/${encodeURIComponent(askId)}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answer === undefined ? {} : { answer }),
    });
    if (!response.ok && response.status !== 409) throw new Error(`Could not close the prompt (${response.status}).`);
  }
}
