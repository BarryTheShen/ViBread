import { describe, expect, it, vi, type Mock } from "vitest";
import { loadServerPage, type LoadableWindow } from "./navigation.js";

const URL_ = "http://127.0.0.1:5173/";
const aborted = () => Object.assign(new Error("ERR_ABORTED (-3) loading 'http://127.0.0.1:5173/'"), { code: "ERR_ABORTED", errno: -3 });

function fakeWindow(results: Array<Error | undefined>, currentUrl: string): LoadableWindow & { loadURL: Mock } {
  const loadURL = vi.fn(async () => {
    const result = results.shift();
    if (result) throw result;
  });
  return { loadURL, webContents: { getURL: () => currentUrl } };
}

describe("loadServerPage", () => {
  it("accepts an aborted load when a reload already put the window on the server", async () => {
    const window = fakeWindow([aborted()], "http://127.0.0.1:5173/");
    await loadServerPage(window, URL_);
    expect(window.loadURL).toHaveBeenCalledTimes(1);
  });

  it("retries once when the reload left the window on the local Starting page", async () => {
    const window = fakeWindow([aborted(), undefined], "file:///app/static/starting.html");
    await loadServerPage(window, URL_);
    expect(window.loadURL).toHaveBeenCalledTimes(2);
  });

  it("throws when the retry is aborted too, or on any other load failure", async () => {
    await expect(loadServerPage(fakeWindow([aborted(), aborted()], ""), URL_)).rejects.toMatchObject({ errno: -3 });
    const refused = Object.assign(new Error("ERR_CONNECTION_REFUSED"), { errno: -102 });
    const window = fakeWindow([refused], "http://127.0.0.1:5173/");
    await expect(loadServerPage(window, URL_)).rejects.toBe(refused);
    expect(window.loadURL).toHaveBeenCalledTimes(1);
  });
});
