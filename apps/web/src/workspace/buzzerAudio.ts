import type { Part } from "@vibread/core";

/** An active buzzer has its own oscillator: any HIGH on its pin sounds this one pitch. */
export const ACTIVE_BUZZER_HZ = 2300;
/** Loudest the whole "Try it" speaker gets (0–1). Square-wave buzzers are harsh, so this stays low. */
export const MAX_GAIN = 0.08;
/** Window over which the simulator measures a tone() pitch; long enough for a few periods of a low note. */
export const TONE_WINDOW_MS = 60;

/** Active buzzers count as sounding once their pin is HIGH for at least this share of the last sample window. */
const ACTIVE_ON_SHARE = 0.25;

export interface ToneSource {
  partState(part: string): number;
  toneFrequency(part: string, windowMs: number): number;
}

/** What each buzzer in the circuit is producing right now, in Hz (0 = silent). Runs in the simulator worker. */
export function buzzerTones(parts: readonly Part[], sim: ToneSource): Record<string, number> {
  const tones: Record<string, number> = {};
  for (const part of parts) {
    if (part.module === "buzzer-active") tones[part.id] = sim.partState(part.id) >= ACTIVE_ON_SHARE ? ACTIVE_BUZZER_HZ : 0;
    else if (part.module === "buzzer-passive") tones[part.id] = Math.round(sim.toneFrequency(part.id, TONE_WINDOW_MS));
  }
  return tones;
}

/** Target pitch and loudness per buzzer: silent while muted; sounding buzzers share MAX_GAIN so two never get louder. */
export function voiceTargets(tones: Record<string, number>, muted: boolean): Record<string, { hz: number; gain: number }> {
  const sounding = Object.values(tones).filter((hz) => hz > 0).length;
  const targets: Record<string, { hz: number; gain: number }> = {};
  for (const [part, hz] of Object.entries(tones)) {
    targets[part] = { hz, gain: !muted && hz > 0 ? MAX_GAIN / sounding : 0 };
  }
  return targets;
}

export const isSounding = (tones: Record<string, number>): boolean => Object.values(tones).some((hz) => hz > 0);

interface Voice {
  oscillator: OscillatorNode;
  gain: GainNode;
}

/**
 * Plays the simulator's buzzers with Web Audio: one square-wave oscillator per buzzer whose pitch/loudness glide to the
 * targets every simulator tick (~20 ms). The AudioContext is created on the first unmute (a click, so autoplay rules
 * allow it) and every sound stops on mute, pause (tab hidden) and dispose (Reset, panel closed, navigation).
 */
export class BuzzerAudio {
  private context: AudioContext | undefined;
  private readonly voices = new Map<string, Voice>();
  private muted = true;
  private paused = false;
  private last: Record<string, number> = {};

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted && !this.context) this.context = new AudioContext();
    if (!muted && !this.paused) void this.context?.resume();
    this.update(this.last);
  }

  /** The tab went to the background (or came back): silence without forgetting the mute choice. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) void this.context?.suspend();
    else if (!this.muted) void this.context?.resume();
  }

  update(tones: Record<string, number>): void {
    this.last = tones;
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    for (const [part, target] of Object.entries(voiceTargets(tones, this.muted))) {
      let voice = this.voices.get(part);
      if (!voice && target.gain === 0) continue;
      if (!voice) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "square";
        gain.gain.value = 0;
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        voice = { oscillator, gain };
        this.voices.set(part, voice);
      }
      if (target.hz > 0) voice.oscillator.frequency.setTargetAtTime(target.hz, now, 0.003);
      voice.gain.gain.setTargetAtTime(target.gain, now, 0.008);
    }
  }

  /** Silence everything now (Reset): the next update starts from quiet. */
  silence(): void {
    this.last = {};
    const now = this.context?.currentTime ?? 0;
    for (const voice of this.voices.values()) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(0, now);
    }
  }

  dispose(): void {
    this.silence();
    for (const voice of this.voices.values()) voice.oscillator.stop();
    this.voices.clear();
    void this.context?.close();
    this.context = undefined;
  }
}
