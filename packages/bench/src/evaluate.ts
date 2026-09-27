import {
  BREADBOARD_PROFILES,
  VCC_PASS_MV,
  contactGroup,
  parseHole,
  type BenchRunResult,
  type BenchTestResult,
  type Calibration,
  type Circuit,
  type DeviceLine,
  type Endpoint,
  type HoleId,
  type Layout,
  type SelfTestPlan,
  type SelfTestSubject,
  type SubjectResult,
} from "@vibread/core";
import { runDiagnosisRules, type DiagnosisSignature, type RuleCause, type RuleEvent } from "./rules.js";
import { rankFaults, type FaultDictionary } from "./faults.js";

const ADC_FULL_SCALE = 1023;
const LIGHT_CHANGE_MIN = ADC_FULL_SCALE * 0.15;
const PINNED_LOW = 5;
const PINNED_HIGH = 1018;
const SHORT_SUSPECTED_REASON = "short-suspected" as const;
const SHORT_SUSPECTED_MESSAGE = "The board lost power or stopped answering when you plugged in — unplug now and check for a short between the red + and blue − rails, or a part bridging them";

type TestStatus = SubjectResult["status"];


interface SignatureState {
  buttonStuckLow: boolean;
  buttonPin?: string;
  buttonPart?: string;
  ledMismatch: boolean;
  ledNoLight: boolean;
  ledExpectedPart?: string;
  ledExpectedOrder?: number;
  ledObservedOrder?: number;
  lightPinnedRail: boolean;
  lightPin?: string;
  lightPart?: string;
  outputStuck: boolean;
  outputPin?: string;
  outputPart?: string;
  outputLevel?: 0 | 1;
  noBanner: boolean;
  designMismatch: boolean;
}

interface EvaluationContext {
  circuit: Circuit;
  layout?: Layout;
  plan: SelfTestPlan;
  lines: DeviceLine[];
  answers: Record<string, string>;
  subjects: SelfTestSubject[];
  signatures: SignatureState;
  calibrations: Calibration[];
}



function linesForTest(lines: DeviceLine[], test: string): DeviceLine[] {
  const selected: DeviceLine[] = [];
  let active: string | undefined;
  for (const line of lines) {
    if (line.t === "begin") active = line.test;
    if (active === test) selected.push(line);
    if (line.t === "end" && active === line.test) active = undefined;
  }
  if (selected.length > 0 || lines.some((line) => line.t === "begin")) return selected;
  if (test === "pins.readonly") return lines.filter((line) => line.t === "read" || line.t === "probe");
  if (test === "button.interactive") return lines.filter((line) => line.t === "read" || line.t === "obs");
  return selected;
}


function asksFor(lines: DeviceLine[], test: string, kind?: Extract<DeviceLine, { t: "ask" }>['kind']): Array<Extract<DeviceLine, { t: "ask" }>> {
  return lines.filter(
    (line): line is Extract<DeviceLine, { t: "ask" }> => line.t === "ask" && line.test === test && (kind === undefined || line.kind === kind),
  );
}

function endStatus(lines: DeviceLine[], test: string): Exclude<Extract<DeviceLine, { t: "end" }>['status'], "skipped"> | undefined {
  const ends = lines.filter(
    (line): line is Extract<DeviceLine, { t: "end" }> => line.t === "end" && line.test === test,
  );
  const last = ends.at(-1);
  return last?.status === "skipped" ? undefined : last?.status;
}

function aggregate(statuses: TestStatus[]): TestStatus {
  if (statuses.some((status) => status === "fail")) return "fail";
  if (statuses.some((status) => status === "unknown")) return "unknown";
  if (statuses.some((status) => status === "skipped")) return "skipped";
  return "pass";
}

function testResult(test: BenchTestResult["test"], subjects: SubjectResult[], summary: string): BenchTestResult {
  return { test, status: aggregate(subjects.map((subject) => subject.status)), subjects, summary };
}


function ratio(line: Extract<DeviceLine, { t: "read" }>): number | undefined {
  if (line.n <= 0 || line.ones < 0 || line.ones > line.n) return undefined;
  return line.ones / line.n;
}

function stableLevel(line: Extract<DeviceLine, { t: "read" }>): 0 | 1 | undefined {
  const value = ratio(line);
  if (value === undefined) return undefined;
  if (value >= 0.9) return 1;
  if (value <= 0.1) return 0;
  return undefined;
}

function statusForEnd(lines: DeviceLine[], test: string): TestStatus | undefined {
  const status = endStatus(lines, test);
  if (status === "fail") return "fail";
  if (status === "unknown") return "unknown";
  if (status === "pass") return "pass";
  return undefined;
}

function evaluateRails(context: EvaluationContext): BenchTestResult {
  const lines = context.lines;
  const hello = lines.find((line): line is Extract<DeviceLine, { t: "hello" }> => line.t === "hello");
  const vcc = lines.find((line): line is Extract<DeviceLine, { t: "vcc" }> => line.t === "vcc");
  // Firmware for another design or board is a flashing problem, never a wiring one: check it before any power verdict.
  const designMismatch = hello !== undefined && (hello.design !== context.plan.design || hello.board !== context.plan.board);
  // The check started (the firmware began rails.vcc) but no reading came: the board browned out or reset mid-check.
  // A board that never began the check, even one that said hello, tells nothing about power.
  const railStarted = lines.some((line) => line.t === "begin" && line.test === "rails.vcc");
  const shortSuspected = vcc === undefined && !designMismatch && railStarted;
  let status: TestStatus = vcc === undefined
    ? shortSuspected ? "fail" : "unknown"
    : vcc.mv >= VCC_PASS_MV.min && vcc.mv <= VCC_PASS_MV.max
      ? "pass"
      : "fail";
  let observed = vcc === undefined ? "no board VCC reading" : `${vcc.mv} mV`;
  if (hello === undefined) {
    observed = vcc === undefined ? "no hello banner or board VCC reading" : `${vcc.mv} mV, but no hello banner`;
  } else if (designMismatch) {
    context.signatures.designMismatch = true;
    status = "fail";
    observed = vcc === undefined
      ? `hello design ${hello.design}, board ${hello.board}; no board VCC reading`
      : `${vcc.mv} mV; hello design ${hello.design}, board ${hello.board}`;
  }
  const subject: SubjectResult = {
    part: "board power",
    pin: "VCC",
    status,
    observed,
    expected: `VCC ≈ 5 V (${VCC_PASS_MV.min}–${VCC_PASS_MV.max} mV) and design ${context.plan.design}`,
  };
  const summary = designMismatch && hello
    ? `The board's banner says design ${hello.design}, board ${hello.board}: it runs safe firmware for another design or board. Flash this design's safe firmware again.`
    : shortSuspected
      ? SHORT_SUSPECTED_MESSAGE
      : status === "pass"
        ? "Board power check passed (VCC ≈ 5 V). The part tests that follow exercise the breadboard rails."
        : status === "fail"
          ? "Board power check failed (VCC must be ≈ 5 V). The part tests that follow exercise the breadboard rails."
          : "Board power check needs a VCC reading. The part tests that follow exercise the breadboard rails.";
  const result = testResult("rails.vcc", [subject], summary);
  return shortSuspected ? { ...result, reason: SHORT_SUSPECTED_REASON } : result;
}

function evaluatePins(context: EvaluationContext): { result: BenchTestResult; stuck: BenchTestResult | undefined } {
  const segment = linesForTest(context.lines, "pins.readonly");
  const readLines = segment.filter((line): line is Extract<DeviceLine, { t: "read" }> => line.t === "read");
  const probes = segment.filter((line): line is Extract<DeviceLine, { t: "probe" }> => line.t === "probe");
  const stuckLines = context.lines.filter((line): line is Extract<DeviceLine, { t: "stuck" }> => line.t === "stuck");
  const subjects: SubjectResult[] = [];
  const stuckSubjects: SubjectResult[] = [];

  for (const subject of context.subjects) {
    if (subject.kind === "button") {
      const desiredPull = subject.pull === "internal-up" ? 1 : 0;
      const releasedLevel = subject.pressedLevel === 0 ? 1 : 0;
      const read = readLines.find((candidate) => candidate.pin === subject.pin && candidate.pull === desiredPull);
      const stuck = stuckLines.find((candidate) => candidate.pin === subject.pin);
      let status: TestStatus = "unknown";
      let observed = "no released-state read";
      if (stuck !== undefined) {
        status = "fail";
        observed = `stuck ${stuck.level === 0 ? "LOW" : "HIGH"}`;
        if (stuck.level === 0 && !context.signatures.buttonStuckLow) {
          context.signatures.buttonStuckLow = true;
          context.signatures.buttonPin = subject.pin;
          context.signatures.buttonPart = subject.part;
        }
      } else if (read !== undefined) {
        const level = stableLevel(read);
        if (level === undefined) {
          observed = `${read.ones}/${read.n} HIGH samples (indeterminate)`;
        } else {
          observed = level === 1 ? "HIGH" : "LOW";
          status = level === releasedLevel ? "pass" : "fail";
          if (status === "fail" && level === 0) {
            context.signatures.buttonStuckLow = true;
            context.signatures.buttonPin = subject.pin;
            context.signatures.buttonPart = subject.part;
          }
        }
      }
      subjects.push({ part: subject.part, pin: subject.pin, status, observed, expected: `released ${releasedLevel === 1 ? "HIGH" : "LOW"} with ${subject.pull}` });
      continue;
    }

    if (subject.kind === "led" || subject.kind === "buzzer") {
      const subjectProbes = probes.filter((probe) => probe.pin === subject.pin);
      const stuck = stuckLines.find((candidate) => candidate.pin === subject.pin);
      let status: TestStatus = "unknown";
      let observed = "no safe readback probe";
      if (stuck !== undefined) {
        status = "fail";
        observed = `stuck ${stuck.level === 0 ? "LOW" : "HIGH"}`;
      } else if (subjectProbes.length > 0) {
        const mismatch = subjectProbes.find((probe) => probe.drive !== probe.readback);
        if (mismatch !== undefined) {
          status = "fail";
          observed = `drive ${mismatch.drive}, readback ${mismatch.readback}`;
        } else {
          status = "pass";
          observed = `${subjectProbes.length} probe readback(s) matched`;
        }
      }
      if (status === "fail") {
        const failingProbe = subjectProbes.find((probe) => probe.drive !== probe.readback);
        const stuckLevel = stuck?.level ?? (failingProbe?.readback ?? 0);
        context.signatures.outputStuck = true;
        context.signatures.outputPin = subject.pin;
        context.signatures.outputPart = subject.part;
        context.signatures.outputLevel = stuckLevel;
      }
      subjects.push({ part: subject.part, pin: subject.pin, status, observed, expected: "probe readback equals the driven level" });
      continue;
    }

    const reads = readLines.filter((read) => read.pin === subject.pin);
    subjects.push({
      part: subject.part,
      pin: subject.pin,
      status: reads.length > 0 ? "pass" : "unknown",
      observed: reads.length > 0 ? `${reads.length} passive read(s)` : "no passive read",
      expected: "safe passive read only",
    });
  }

  for (const line of stuckLines) {
    const subject = context.subjects.find((candidate) => candidate.pin === line.pin);
    const part = subject?.part ?? "board";
    stuckSubjects.push({
      part,
      pin: line.pin,
      status: "fail",
      observed: `stuck ${line.level === 0 ? "LOW" : "HIGH"}`,
      expected: "not stuck",
    });
    if (subject?.kind === "button" && line.level === 0) {
      context.signatures.buttonStuckLow = true;
      context.signatures.buttonPin = line.pin;
      context.signatures.buttonPart = subject.part;
    }
    if (subject !== undefined && (subject.kind === "led" || subject.kind === "buzzer")) {
      context.signatures.outputStuck = true;
      context.signatures.outputPin = line.pin;
      context.signatures.outputPart = subject.part;
      context.signatures.outputLevel = line.level;
    }
  }

  const result = testResult(
    "pins.readonly",
    subjects,
    aggregate(subjects.map((subject) => subject.status)) === "pass" ? "All safe readback probes matched." : "Read-only pin checks found a mismatch or need more telemetry.",
  );
  const stuck = stuckSubjects.length > 0
    ? testResult("digital.stuck", stuckSubjects, `${stuckSubjects.length} pin(s) reported stuck; no further drive should be attempted.`)
    : undefined;
  return { result, stuck };
}

function normalizedAnswer(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase();
}

function answerMissing(raw: string | undefined): boolean {
  const value = normalizedAnswer(raw);
  return value === undefined || value.length === 0 || value === "timeout" || value === "timed out" || value === "unknown";
}

type StableObservation = 0 | 1 | "mixed";

function stableObservation(value: boolean | number | string): StableObservation | undefined {
  if (value === 0 || value === 1 || value === "mixed") return value;
  return undefined;
}

function askForPart(
  lines: DeviceLine[],
  test: Extract<DeviceLine, { t: "ask" }>["test"],
  id: string,
  part: string,
): Extract<DeviceLine, { t: "ask" }> | undefined {
  return lines.find((line): line is Extract<DeviceLine, { t: "ask" }> => line.t === "ask" && line.test === test && line.id === id && line.part === part);
}

function observationForPart(
  lines: DeviceLine[],
  test: Extract<DeviceLine, { t: "obs" }>["test"],
  part: string,
  key: string,
): Extract<DeviceLine, { t: "obs" }> | undefined {
  return lines.find((line): line is Extract<DeviceLine, { t: "obs" }> => line.t === "obs" && line.test === test && line.part === part && line.key === key);
}

function evaluateButton(context: EvaluationContext, subject: Extract<SelfTestSubject, { kind: "button" }>): SubjectResult {
  const buttonSubjects = context.subjects.filter((candidate): candidate is Extract<SelfTestSubject, { kind: "button" }> => candidate.kind === "button");
  const index = buttonSubjects.findIndex((candidate) => candidate.part === subject.part);
  const pressAsk = askForPart(context.lines, "button.interactive", `btn${index}-press`, subject.part);
  const releaseAsk = askForPart(context.lines, "button.interactive", `btn${index}-release`, subject.part);
  const missingAnswer = pressAsk === undefined || releaseAsk === undefined || answerMissing(context.answers[pressAsk.id]) || answerMissing(context.answers[releaseAsk.id]);
  const pressed = observationForPart(context.lines, "button.interactive", subject.part, "pressed");
  const released = observationForPart(context.lines, "button.interactive", subject.part, "released");
  const pressedLevel = pressed === undefined ? undefined : stableObservation(pressed.v);
  const releasedLevel = released === undefined ? undefined : stableObservation(released.v);
  const expectedPressed = subject.pressedLevel;
  const expectedReleased = expectedPressed === 0 ? 1 : 0;
  let status: TestStatus = "unknown";
  let observed = "button transition telemetry is missing";
  if (!missingAnswer && pressedLevel !== undefined && releasedLevel !== undefined && pressedLevel !== "mixed" && releasedLevel !== "mixed") {
    status = pressedLevel === expectedPressed && releasedLevel === expectedReleased ? "pass" : "fail";
    observed = `pressed ${pressedLevel}, released ${releasedLevel}`;
  } else if (statusForEnd(context.lines, "button.interactive") === "fail" && !missingAnswer) {
    status = "fail";
    observed = "device reported a failed button test";
  } else if (missingAnswer) {
    observed = "button answer timed out or its exact prompt is missing";
  } else if (pressedLevel === "mixed" || releasedLevel === "mixed") {
    observed = "button reading was mixed";
  }
  return { part: subject.part, pin: subject.pin, status, observed, expected: `press ${expectedPressed === 1 ? "HIGH" : "LOW"}, release ${expectedReleased === 1 ? "HIGH" : "LOW"}` };
}

function evaluateButtons(context: EvaluationContext): BenchTestResult {
  const subjects = context.subjects.filter((subject): subject is Extract<SelfTestSubject, { kind: "button" }> => subject.kind === "button");
  const results = subjects.map((subject) => evaluateButton(context, subject));
  return testResult("button.interactive", results, aggregate(results.map((result) => result.status)) === "pass" ? "Button transitions matched the pull-up expectation." : "The button needs a clean press-and-release transition.");
}

function adcReadings(context: EvaluationContext, subject: Extract<SelfTestSubject, { kind: "light" | "pot" }>): Array<Extract<DeviceLine, { t: "adc" }>> {
  return context.lines.filter(
    (line): line is Extract<DeviceLine, { t: "adc" }> => line.t === "adc" && line.pin === subject.pin,
  );
}

function firstPhase(readings: Array<Extract<DeviceLine, { t: "adc" }>>, phase: string): number | undefined {
  const reading = readings.find((candidate) => candidate.phase.toLowerCase() === phase);
  return reading !== undefined && Number.isFinite(reading.med) ? reading.med : undefined;
}

function calibrationFor(part: string, ambient: number, covered: number): Calibration {
  const threshold = (ambient + covered) / 2;
  const hysteresis = Math.max(10, Math.abs(ambient - covered) * 0.1);
  return {
    part,
    ambient,
    covered,
    threshold,
    hysteresis,
    macros: {
      [`VB_CAL_${part}_DARK`]: threshold,
      [`VB_CAL_${part}_HYST`]: hysteresis,
    },
  };
}

function evaluateLight(context: EvaluationContext, subject: Extract<SelfTestSubject, { kind: "light" }>): SubjectResult {
  const readings = adcReadings(context, subject);
  const ambient = firstPhase(readings, "ambient");
  const covered = firstPhase(readings, "covered");
  if (ambient !== undefined && covered !== undefined) context.calibrations.push(calibrationFor(subject.part, ambient, covered));
  const lightSubjects = context.subjects.filter((candidate): candidate is Extract<SelfTestSubject, { kind: "light" }> => candidate.kind === "light");
  const index = lightSubjects.findIndex((candidate) => candidate.part === subject.part);
  const coverAsk = askForPart(context.lines, "light.relative", `light${index}-cover`, subject.part);
  const uncoverAsk = askForPart(context.lines, "light.relative", `light${index}-uncover`, subject.part);
  const missingAnswer = coverAsk === undefined || uncoverAsk === undefined || answerMissing(context.answers[coverAsk.id]) || answerMissing(context.answers[uncoverAsk.id]);
  if (ambient === undefined || covered === undefined) {
    const status = statusForEnd(context.lines, "light.relative") === "fail" ? "fail" : "unknown";
    return { part: subject.part, pin: subject.pin, status, observed: status === "fail" ? "device reported a failed light test without ADC data" : "ambient or covered ADC reading is missing", expected: "at least 15% ADC change when covered" };
  }
  const pinnedAmbient = ambient <= PINNED_LOW || ambient >= PINNED_HIGH;
  const pinnedCovered = covered <= PINNED_LOW || covered >= PINNED_HIGH;
  if (pinnedAmbient || pinnedCovered) {
    context.signatures.lightPinnedRail = true;
    context.signatures.lightPin = subject.pin;
    context.signatures.lightPart = subject.part;
    return { part: subject.part, pin: subject.pin, status: "fail", observed: `ADC ${ambient} → ${covered} (pinned at a rail)`, expected: "ambient and covered readings away from 0/1023 rails" };
  }
  const delta = Math.abs(ambient - covered);
  const direction = subject.brighterReadsHigher ? ambient > covered : ambient < covered;
  const status: TestStatus = delta >= LIGHT_CHANGE_MIN && direction && !missingAnswer ? "pass" : delta < LIGHT_CHANGE_MIN || !direction ? "fail" : "unknown";
  return {
    part: subject.part,
    pin: subject.pin,
    status,
    observed: `ADC ${ambient} → ${covered} (Δ ${Math.round(delta)})`,
    expected: `${Math.round(LIGHT_CHANGE_MIN)}+ ADC counts and ${subject.brighterReadsHigher ? "ambient higher than covered" : "ambient lower than covered"}`,
  };
}

function evaluateLights(context: EvaluationContext): BenchTestResult {
  const subjects = context.subjects.filter((subject): subject is Extract<SelfTestSubject, { kind: "light" }> => subject.kind === "light");
  const results = subjects.map((subject) => evaluateLight(context, subject));
  return testResult("light.relative", results, aggregate(results.map((result) => result.status)) === "pass" ? "The sensor changed enough between room light and a covered sensor." : "The light sensor did not produce a reliable relative change.");
}

function evaluatePot(context: EvaluationContext, subject: Extract<SelfTestSubject, { kind: "pot" }>): SubjectResult {
  const readings = adcReadings(context, subject);
  const min = firstPhase(readings, "min");
  const max = firstPhase(readings, "max");
  const potSubjects = context.subjects.filter((candidate): candidate is Extract<SelfTestSubject, { kind: "pot" }> => candidate.kind === "pot");
  const index = potSubjects.findIndex((candidate) => candidate.part === subject.part);
  const minAsk = askForPart(context.lines, "pot.sweep", `pot${index}-min`, subject.part);
  const maxAsk = askForPart(context.lines, "pot.sweep", `pot${index}-max`, subject.part);
  const missingAnswer = minAsk === undefined || maxAsk === undefined || answerMissing(context.answers[minAsk.id]) || answerMissing(context.answers[maxAsk.id]);
  if (min === undefined || max === undefined) {
    const status = statusForEnd(context.lines, "pot.sweep") === "fail" ? "fail" : "unknown";
    return { part: subject.part, pin: subject.pin, status, observed: status === "fail" ? "device reported a failed pot test without ADC data" : "minimum or maximum ADC reading is missing", expected: "pot span ≥ 50% of full scale" };
  }
  const span = Math.abs(max - min);
  const status: TestStatus = span >= ADC_FULL_SCALE * 0.5 ? (missingAnswer ? "unknown" : "pass") : "fail";
  return { part: subject.part, pin: subject.pin, status, observed: `ADC ${min} → ${max} (span ${Math.round(span)})`, expected: `span ≥ ${Math.round(ADC_FULL_SCALE * 0.5)} counts` };
}

function evaluatePots(context: EvaluationContext): BenchTestResult {
  const subjects = context.subjects.filter((subject): subject is Extract<SelfTestSubject, { kind: "pot" }> => subject.kind === "pot");
  const results = subjects.map((subject) => evaluatePot(context, subject));
  return testResult("pot.sweep", results, aggregate(results.map((result) => result.status)) === "pass" ? "The knob swept across its usable range." : "The knob did not show a half-scale sweep.");
}

function evaluateLeds(context: EvaluationContext): BenchTestResult {
  const leds = context.subjects.filter((subject): subject is Extract<SelfTestSubject, { kind: "led" }> => subject.kind === "led");
  const asks = asksFor(context.lines, "led.sequence", "which-led");
  const subjectResults = leds.map((led) => {
    const ask = asks.find((candidate) => candidate.id === `led${led.order}` && candidate.part === led.part);
    const raw = ask === undefined ? undefined : context.answers[ask.id];
    const observation = observationForPart(context.lines, "led.sequence", led.part, "which");
    const telemetryAnswer = observation === undefined ? undefined : String(observation.v);
    const missing = ask === undefined || answerMissing(raw);
    if (raw === "none" || telemetryAnswer === "none") context.signatures.ledNoLight = true;
    let status: TestStatus = "unknown";
    let observed = missing ? "LED answer timed out or its exact prompt is missing" : raw ?? "no answer";
    if (!missing && raw === String(led.order)) {
      if (telemetryAnswer === undefined || telemetryAnswer === raw) {
        status = "pass";
        observed = `light ${raw}`;
      } else {
        status = "fail";
        observed = `answer ${raw}, device observed ${telemetryAnswer}`;
      }
    } else if (!missing) {
      status = "fail";
      observed = raw ?? "unrecognized answer";
    }
    if (status === "fail" && !context.signatures.ledMismatch) {
      context.signatures.ledMismatch = true;
      context.signatures.ledExpectedPart = led.part;
      context.signatures.ledExpectedOrder = led.order;
      const observedOrder = raw === undefined ? undefined : Number(raw);
      context.signatures.ledObservedOrder = Number.isInteger(observedOrder) ? observedOrder : undefined;
    }
    return { part: led.part, pin: led.pin, status, observed, expected: `light ${led.order} (${led.label})` };
  });
  const status = aggregate(subjectResults.map((result) => result.status));
  if (subjectResults.length === 0 || asks.length === 0) {
    const ended = statusForEnd(context.lines, "led.sequence");
    if (ended === "fail") return testResult("led.sequence", subjectResults, "The device reported an LED sequence failure.");
  }
  return testResult(
    "led.sequence",
    subjectResults,
    status === "pass" ? "The person identified each LED in the expected order." : "The blinking LED answers did not match the physical order.",
  );
}

function evaluateBuzzer(context: EvaluationContext): BenchTestResult {
  const buzzers = context.subjects.filter((subject): subject is Extract<SelfTestSubject, { kind: "buzzer" }> => subject.kind === "buzzer");
  const subjects = buzzers.map((buzzer, index) => {
    const ask = askForPart(context.lines, "buzzer.confirm", `buzzer${index}`, buzzer.part);
    const raw = ask === undefined ? undefined : context.answers[ask.id];
    const value = normalizedAnswer(raw);
    let status: TestStatus = "unknown";
    let observed = "buzzer answer timed out or its exact prompt is missing";
    if (ask !== undefined && !answerMissing(raw)) {
      status = value === "yes" ? "pass" : "fail";
      observed = value === "yes" ? "heard a beep" : "no beep heard";
    }
    return { part: buzzer.part, pin: buzzer.pin, status, observed, expected: "heard a beep (yes)" };
  });
  return testResult("buzzer.confirm", subjects, aggregate(subjects.map((subject) => subject.status)) === "pass" ? "The buzzer was audible." : "The buzzer needs an audible confirmation.");
}

function endpointHole(endpoint: Endpoint): HoleId | undefined {
  return "hole" in endpoint ? endpoint.hole : undefined;
}


function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function netIdsForPart(circuit: Circuit, partId: string): Set<string> {
  const ids = new Set<string>();
  const queue: string[] = [];
  for (const net of circuit.nets) {
    if (net.pins.some((pin) => pin.part === partId)) {
      ids.add(net.id);
      queue.push(net.id);
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const netId = queue.shift();
    if (netId === undefined || visited.has(netId)) continue;
    visited.add(netId);
    const net = circuit.nets.find((candidate) => candidate.id === netId);
    if (net === undefined || net.kind !== "signal") continue;
    for (const ref of net.pins) {
      const part = circuit.parts.find((candidate) => candidate.id === ref.part);
      if (part?.module !== "resistor") continue;
      const otherPin = ref.pin === "1" ? "2" : "1";
      const otherNet = circuit.nets.find((candidate) => candidate.pins.some((pin) => pin.part === ref.part && pin.pin === otherPin));
      if (otherNet !== undefined && !ids.has(otherNet.id)) {
        ids.add(otherNet.id);
        queue.push(otherNet.id);
      }
    }
  }
  return ids;
}

function highlightForCause(cause: string, context: EvaluationContext): { holes: HoleId[]; parts: string[]; jumpers: string[] } {
  const layout = context.layout;
  if (layout === undefined) return { holes: [], parts: [], jumpers: [] };
  const profile = BREADBOARD_PROFILES[context.circuit.breadboard.profile];
  const parts = new Set<string>();
  const jumpers = new Set<string>();
  const holes = new Set<HoleId>();
  const addPart = (partId: string | undefined): void => {
    if (partId === undefined) return;
    parts.add(partId);
    const placement = layout.placements.find((candidate) => candidate.part === partId);
    if (placement !== undefined) for (const hole of Object.values(placement.pins)) holes.add(hole);
  };
  const addJumper = (jumperId: string): void => {
    jumpers.add(jumperId);
    const jumper = layout.jumpers.find((candidate) => candidate.id === jumperId);
    if (jumper !== undefined) {
      const from = endpointHole(jumper.from);
      const to = endpointHole(jumper.to);
      if (from !== undefined) holes.add(from);
      if (to !== undefined) holes.add(to);
    }
  };
  const jumperNetIds = (partId: string): void => {
    const nets = netIdsForPart(context.circuit, partId);
    for (const jumper of layout.jumpers) if (nets.has(jumper.net)) addJumper(jumper.id);
  };

  if (cause === "button-leg-in-gnd-row" || cause === "button-rotated-90" || cause === "jumper-to-gnd") {
    const buttonId = context.signatures.buttonPart ?? context.subjects.find((subject) => subject.kind === "button")?.part;
    addPart(buttonId);
    if (buttonId !== undefined) {
      const groundNetIds = new Set(context.circuit.nets.filter((net) => net.kind === "ground" && net.pins.some((pin) => pin.part === buttonId)).map((net) => net.id));
      const placement = layout.placements.find((candidate) => candidate.part === buttonId);
      const buttonGroundHoles = placement === undefined
        ? []
        : Object.entries(placement.pins).filter(([pin]) => context.circuit.nets.some((net) => groundNetIds.has(net.id) && net.pins.some((ref) => ref.part === buttonId && ref.pin === pin))).map(([, hole]) => hole);
      for (const hole of buttonGroundHoles) holes.add(hole);
      const groups = new Set(buttonGroundHoles.map((hole) => contactGroup(profile, hole)).filter((group): group is string => group !== null));
      for (const jumper of layout.jumpers) {
        const endpoints = [endpointHole(jumper.from), endpointHole(jumper.to)].filter((hole): hole is HoleId => hole !== undefined);
        if (endpoints.some((hole) => {
          const group = contactGroup(profile, hole);
          return group !== null && groups.has(group);
        })) addJumper(jumper.id);
      }
    }
  } else if (cause === "led-jumpers-swapped" || cause === "led-reversed" || cause === "led-missing") {
    const expected = context.signatures.ledExpectedPart;
    addPart(expected);
    if (expected !== undefined) jumperNetIds(expected);
    for (const subject of context.subjects) if (subject.kind === "led" && (cause === "led-jumpers-swapped" || subject.part === expected)) {
      addPart(subject.part);
      jumperNetIds(subject.part);
    }
  } else if (cause === "divider-resistor-missing" || cause === "sensor-missing" || cause === "sensor-wrong-row") {
    const lightPart = context.signatures.lightPart ?? context.subjects.find((subject) => subject.kind === "light")?.part;
    addPart(lightPart);
    if (lightPart !== undefined) jumperNetIds(lightPart);
    const lightNets = netIdsForPart(context.circuit, lightPart ?? "");
    for (const part of context.circuit.parts) {
      if (part.module !== "resistor") continue;
      if (context.circuit.nets.some((net) => lightNets.has(net.id) && net.pins.some((pin) => pin.part === part.id))) {
        addPart(part.id);
        jumperNetIds(part.id);
      }
    }
  } else if (cause === "output-jumper-in-rail-row" || cause === "missing-resistor") {
    const outputPart = context.signatures.outputPart ?? context.subjects.find((subject) => subject.kind === "led" || subject.kind === "buzzer")?.part;
    addPart(outputPart);
    if (outputPart !== undefined) jumperNetIds(outputPart);
    if (cause === "missing-resistor" && outputPart !== undefined) {
      const outputNets = netIdsForPart(context.circuit, outputPart);
      for (const part of context.circuit.parts) {
        if (part.module === "resistor" && context.circuit.nets.some((net) => outputNets.has(net.id) && net.pins.some((pin) => pin.part === part.id))) addPart(part.id);
      }
    }
  } else if (cause === "rail-short" || cause === "cable") {
    for (const jumper of layout.jumpers) if (jumper.net === "5V" || jumper.net === "GND") addJumper(jumper.id);
  }

  return { holes: unique([...holes]), parts: unique([...parts]), jumpers: unique([...jumpers]) };
}

function rowForPart(context: EvaluationContext, partId: string | undefined, pin?: string): number | undefined {
  if (context.layout === undefined || partId === undefined) return undefined;
  const placement = context.layout.placements.find((candidate) => candidate.part === partId);
  if (placement === undefined) return undefined;
  const hole = pin === undefined ? Object.values(placement.pins)[0] : placement.pins[pin];
  const parsed = hole === undefined ? undefined : parseHole(hole);
  return parsed?.kind === "terminal" ? parsed.row : undefined;
}
function buttonGroundRow(context: EvaluationContext, partId: string): number | undefined {
  if (context.layout === undefined) return undefined;
  const placement = context.layout.placements.find((candidate) => candidate.part === partId);
  const groundNet = context.circuit.nets.find((net) => net.kind === "ground" && net.pins.some((ref) => ref.part === partId));
  if (placement === undefined || groundNet === undefined) return undefined;
  const profile = BREADBOARD_PROFILES[context.layout.breadboard];
  const groundHoles = groundNet.pins.map((ref) => placement.pins[ref.pin]).filter((hole): hole is HoleId => hole !== undefined);
  const groups = new Set(groundHoles.map((hole) => contactGroup(profile, hole)).filter((group): group is string => group !== null));
  for (const jumper of context.layout.jumpers.filter((candidate) => candidate.net === groundNet.id)) {
    for (const endpoint of [jumper.from, jumper.to]) {
      const hole = endpointHole(endpoint);
      const parsed = hole === undefined ? undefined : parseHole(hole);
      if (parsed?.kind === "terminal" && hole !== undefined && groups.has(contactGroup(profile, hole) ?? "")) return parsed.row;
    }
  }
  const parsed = groundHoles.map((hole) => parseHole(hole)).find((value) => value?.kind === "terminal");
  return parsed?.kind === "terminal" ? parsed.row : undefined;
}

function primaryRule(events: RuleEvent[]): RuleEvent | undefined {
  return [...events].sort((left, right) => right.priority - left.priority)[0];
}

function signatureRecord(signatures: SignatureState): Record<DiagnosisSignature, boolean> {
  return {
    buttonStuckLow: signatures.buttonStuckLow,
    ledMismatch: signatures.ledMismatch,
    lightPinnedRail: signatures.lightPinnedRail,
    outputStuck: signatures.outputStuck,
    noBanner: signatures.noBanner,
  };
}

function summaryFor(event: RuleEvent | undefined, context: EvaluationContext, fallback: string): string {
  if (event === undefined) return fallback;
  switch (event.signature) {
    case "buttonStuckLow": {
      const pin = context.signatures.buttonPin ?? "the button pin";
      const part = context.signatures.buttonPart ?? context.subjects.find((subject) => subject.kind === "button")?.part ?? "button";
      const row = buttonGroundRow(context, part) ?? rowForPart(context, part);
      return `Houston, we have a problem: ${pin} reads LOW even with ${part} released — its leg${row === undefined ? "" : ` shares row ${row}`} with the GND jumper.`;
    }
    case "ledMismatch": {
      const part = context.signatures.ledExpectedPart ?? "the LED";
      const expected = context.signatures.ledExpectedOrder ?? 0;
      const observed = context.signatures.ledObservedOrder ?? 0;
      const row = rowForPart(context, part);
      const observedText = observed === 0 ? "no light" : `light ${observed}`;
      return `Houston, we have a problem: ${part} on light ${expected} showed ${observedText}${row === undefined ? "" : ` near row ${row}`} — check the LED jumpers.`;
    }
    case "lightPinnedRail": {
      const pin = context.signatures.lightPin ?? "the light pin";
      const part = context.signatures.lightPart ?? "light sensor";
      const row = rowForPart(context, part);
      return `Houston, we have a problem: ${pin} (${part}) is pinned at a rail in both light phases${row === undefined ? "" : ` near row ${row}`} — inspect the divider.`;
    }
    case "outputStuck": {
      const pin = context.signatures.outputPin ?? "the output pin";
      const part = context.signatures.outputPart ?? "output";
      const level = context.signatures.outputLevel === 0 ? "LOW" : "HIGH";
      const row = rowForPart(context, part);
      return `Houston, we have a problem: ${pin} (${part}) is stuck ${level}${row === undefined ? "" : ` near row ${row}`} — unplug before changing the wiring.`;
    }
    case "noBanner": {
      const railRow = event.causes.some((cause) => cause.cause === "rail-short") ? rowForPart(context, "board") : undefined;
      return `Houston, we have a problem: the board did not send its hello banner${railRow === undefined ? "" : ` near row ${railRow}`} — unplug, check the 5 V/GND rails, and try a data USB cable.`;
    }
  }
}

function candidateScore(event: RuleEvent, cause: RuleCause): number {
  return event.priority + cause.likelihood;
}

function candidatesFor(events: RuleEvent[], context: EvaluationContext): BenchRunResult["diagnosis"]["candidates"] {
  const candidates = events.flatMap((event) => event.causes.map((cause) => {
    const likelihood = context.signatures.ledNoLight && event.signature === "ledMismatch"
      ? cause.cause === "led-missing" ? 0.75 : cause.cause === "led-reversed" ? 0.2 : 0.05
      : cause.likelihood;
    return { event, cause, likelihood, score: event.priority + likelihood };
  }));
  candidates.sort((left, right) => right.score - left.score);
  return candidates.map(({ cause, likelihood }) => ({
    cause: cause.cause,
    title: cause.title,
    likelihood,
    highlight: highlightForCause(cause.cause, context),
    fix: cause.fix,
  }));
}
function summaryWithAmbiguity(summary: string, candidates: BenchRunResult["diagnosis"]["candidates"], context: EvaluationContext): string {
  const divider = candidates.find((candidate) => candidate.cause === "divider-resistor-missing");
  const jumper = candidates.find((candidate) => candidate.cause === "missing-jumper");
  if (context.signatures.lightPinnedRail && divider !== undefined && jumper !== undefined && Math.abs(divider.likelihood - jumper.likelihood) <= 0.2) {
    const pin = context.signatures.lightPin ?? "the light pin";
    const part = context.signatures.lightPart ?? "light sensor";
    const row = rowForPart(context, part);
    return `Houston, we have a problem: ${pin} (${part}) is disconnected${row === undefined ? "" : ` near row ${row}`} — the divider resistor or its jumper is missing.`;
  }
  return summary;
}
function incompleteSummary(lines: DeviceLine[], answers: Record<string, string>): string {
  const ask = lines.find((line): line is Extract<DeviceLine, { t: "ask" }> => line.t === "ask" && answerMissing(answers[line.id]));
  if (ask === undefined) return "The bench did not return a complete telemetry signature.";
  const wording: Record<Extract<DeviceLine, { t: "ask" }>["kind"], string> = {
    "press-hold": "Press the button",
    release: "Release the button",
    cover: "Cover the light sensor",
    uncover: "Uncover the light sensor",
    "knob-min": "Turn the knob down",
    "knob-max": "Turn the knob up",
    "which-led": "Which light is blinking",
    "heard-beep": "Listen for the beep",
    confirm: "Confirm the part",
  };
  return `Nobody answered '${wording[ask.kind]}' in time.`;
}

function verdictFor(results: BenchTestResult[]): BenchRunResult["verdict"] {
  if (results.some((result) => result.status === "fail")) return "fail";
  if (results.some((result) => result.status === "unknown")) return "incomplete";
  return "pass";
}

export async function evaluateRun(input: {
  circuit: Circuit;
  layout?: Layout;
  plan: SelfTestPlan;
  lines: DeviceLine[];
  answers: Record<string, string>;
  kind: BenchRunResult["kind"];
  revision: number;
  runId: string;
  faultDictionary?: FaultDictionary;
}): Promise<BenchRunResult> {
  const hasHello = input.lines.some((line) => line.t === "hello");
  const noisyFailure = input.lines.some((line) => {
    if (line.t !== "err" && line.t !== "log") return false;
    return /usb|power|reset|banner|disconnect|drop/i.test(line.msg);
  });
  const context: EvaluationContext = {
    circuit: input.circuit,
    layout: input.layout,
    plan: input.plan,
    lines: input.lines,
    answers: input.answers,
    subjects: input.plan.subjects,
    signatures: {
      buttonStuckLow: false,
      ledMismatch: false,
      ledNoLight: false,
      lightPinnedRail: false,
      outputStuck: false,
      noBanner: !hasHello || noisyFailure,
      designMismatch: false,
    },
    calibrations: [],
  };

  const results: BenchTestResult[] = [];
  for (const test of input.plan.tests) {
    switch (test) {
      case "rails.vcc":
        results.push(evaluateRails(context));
        break;
      case "pins.readonly": {
        const evaluated = evaluatePins(context);
        results.push(evaluated.result);
        if (evaluated.stuck !== undefined) results.push(evaluated.stuck);
        break;
      }
      case "button.interactive":
        results.push(evaluateButtons(context));
        break;
      case "light.relative":
        results.push(evaluateLights(context));
        break;
      case "pot.sweep":
        results.push(evaluatePots(context));
        break;
      case "led.sequence":
        results.push(evaluateLeds(context));
        break;
      case "buzzer.confirm":
        results.push(evaluateBuzzer(context));
        break;
      case "digital.stuck":
      case "net.continuity":
        break;
    }
  }

  const events = await runDiagnosisRules(signatureRecord(context.signatures));
  const primary = primaryRule(events);
  const hello = input.lines.find((line): line is Extract<DeviceLine, { t: "hello" }> => line.t === "hello");
  const helloMatchesPlan = hello !== undefined && hello.design === input.plan.design && hello.board === input.plan.board;
  const executedTests = new Set(results.map((result) => result.test));
  const plannedTestsPresent = input.plan.tests.every((test) => executedTests.has(test));
  let verdict = verdictFor(results);
  if (verdict === "pass" && (!helloMatchesPlan || results.length === 0 || !plannedTestsPresent)) verdict = "incomplete";
  const shortSuspectedRail = results.find((result) => result.test === "rails.vcc" && result.reason === SHORT_SUSPECTED_REASON);
  const bannerMismatch = context.signatures.designMismatch && hello !== undefined ? hello : undefined;
  const fallback = verdict === "pass"
    ? "All bench checks passed."
    : verdict === "incomplete"
      ? "Houston, we have a problem: the bench run is incomplete — telemetry or a human answer timed out."
      : bannerMismatch
        ? `Houston, we have a problem: the board's banner says design ${bannerMismatch.design}, board ${bannerMismatch.board}, not this revision's ${input.plan.design} (${input.plan.board}). Flash this design's safe firmware again.`
        : "Houston, we have a problem: a bench signature did not match the design.";
  const ruleCandidates = candidatesFor(events, context);
  // Firmware for another design explains everything after it: say so, never blame the wiring for it.
  const ruleDiagnosis: BenchRunResult["diagnosis"] = {
    attribution: bannerMismatch ? "design" : shortSuspectedRail !== undefined ? "wiring" : primary?.attribution ?? (verdict === "pass" ? "none" : verdict === "incomplete" ? "unknown" : "component"),
    candidates: bannerMismatch ? [] : ruleCandidates,
    summary: bannerMismatch ? fallback : shortSuspectedRail?.summary ?? summaryFor(primary, context, fallback),
  };
  const baseResult: BenchRunResult = {
    runId: input.runId,
    revision: input.revision,
    kind: input.kind,
    results,
    diagnosis: ruleDiagnosis,
    calibration: context.calibrations,
    verdict,
  };
  if (verdict === "pass") return { ...baseResult, diagnosis: { ...ruleDiagnosis, attribution: "none", candidates: [] } };
  if (verdict === "incomplete") return { ...baseResult, diagnosis: { ...ruleDiagnosis, attribution: "none", candidates: [], summary: incompleteSummary(input.lines, input.answers) } };
  if (bannerMismatch) return baseResult;
  let candidates = ruleCandidates;
  if (input.layout !== undefined && input.faultDictionary !== undefined) {
    const dictionaryCandidates = rankFaults({
      circuit: input.circuit,
      layout: input.layout,
      plan: input.plan,
      observed: baseResult,
      lines: input.lines,
      dictionary: input.faultDictionary,
    });
    const merged = new Map(ruleCandidates.map((candidate) => [candidate.cause, candidate]));
    for (const candidate of dictionaryCandidates) {
      const existing = merged.get(candidate.cause);
      if (existing === undefined || candidate.likelihood > existing.likelihood) merged.set(candidate.cause, candidate);
    }
    candidates = [...merged.values()].sort((left, right) => right.likelihood - left.likelihood || left.cause.localeCompare(right.cause));
  }
  return { ...baseResult, diagnosis: { ...ruleDiagnosis, candidates, summary: summaryWithAmbiguity(ruleDiagnosis.summary, candidates, context) } };
}

export function calibrationMacros(calibration: Calibration[]): Record<string, number> {
  const macros: Record<string, number> = {};
  for (const entry of calibration) {
    const generated = {
      [`VB_CAL_${entry.part}_DARK`]: entry.threshold,
      [`VB_CAL_${entry.part}_HYST`]: entry.hysteresis,
    };
    for (const [name, value] of Object.entries(generated)) macros[name] = value;
    for (const [name, value] of Object.entries(entry.macros)) macros[name] = value;
  }
  return macros;
}
