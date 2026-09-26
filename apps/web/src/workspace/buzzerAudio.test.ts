import type { Part } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { ACTIVE_BUZZER_HZ, MAX_GAIN, buzzerTones, voiceTargets } from "./buzzerAudio.js";

const part = (id: string, module: Part["module"]): Part => ({ id, module, params: {} });

describe("buzzerTones", () => {
  const parts = [part("BZ1", "buzzer-active"), part("BZ2", "buzzer-passive"), part("LED1", "led")];

  it("an active buzzer sounds its own fixed pitch while its pin is HIGH; a passive one plays the measured tone() pitch", () => {
    const sim = { partState: (id: string) => (id === "BZ1" ? 1 : 0), toneFrequency: (id: string) => (id === "BZ2" ? 439.6 : 0) };
    expect(buzzerTones(parts, sim)).toEqual({ BZ1: ACTIVE_BUZZER_HZ, BZ2: 440 });
  });

  it("a mostly-LOW active buzzer and a passive buzzer with no edges are silent; other parts are ignored", () => {
    const sim = { partState: () => 0.1, toneFrequency: () => 0 };
    expect(buzzerTones(parts, sim)).toEqual({ BZ1: 0, BZ2: 0 });
  });
});

describe("voiceTargets", () => {
  it("muted means every voice is silent but keeps its pitch", () => {
    expect(voiceTargets({ BZ1: 440, BZ2: 0 }, true)).toEqual({ BZ1: { hz: 440, gain: 0 }, BZ2: { hz: 0, gain: 0 } });
  });

  it("unmuted, sounding buzzers share the gain cap so two together are no louder than one", () => {
    expect(voiceTargets({ BZ1: 440 }, false)).toEqual({ BZ1: { hz: 440, gain: MAX_GAIN } });
    const both = voiceTargets({ BZ1: 440, BZ2: 2300, BZ3: 0 }, false);
    expect(both.BZ1.gain + both.BZ2.gain).toBeCloseTo(MAX_GAIN);
    expect(both.BZ3.gain).toBe(0);
  });
});
