import type { DeviceLine, SelfTestPlan } from "@vibread/core";

interface PromptChoice {
  value: string;
  label: string;
}

function subjectLabel(ask: Extract<DeviceLine, { t: "ask" }>, plan: SelfTestPlan): string {
  if (ask.part !== undefined) {
    const subject = plan.subjects.find((candidate) => candidate.part === ask.part);
    if (subject !== undefined) return subject.label;
    return ask.part;
  }
  return "this part";
}

function choiceLabel(value: string, plan: SelfTestPlan): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "done") return "Done";
  if (normalized === "timeout") return "I can't tell";
  if (normalized === "yes") return "Yes";
  if (normalized === "no") return "No";
  if (normalized === "none") return "None of them";
  if (/^\d+$/.test(normalized)) {
    const order = Number(normalized);
    const led = plan.subjects.find((subject) => subject.kind === "led" && subject.order === order);
    return led === undefined ? `Light ${order}` : `${order} — ${led.label}`;
  }
  return value;
}

function choicesFor(ask: Extract<DeviceLine, { t: "ask" }>, plan: SelfTestPlan): PromptChoice[] {
  let source = ask.choices;
  if (source.length === 0 && ask.kind === "which-led") {
    source = plan.subjects.filter((subject) => subject.kind === "led").map((subject) => String(subject.order));
  }
  if (source.length === 0) source = ask.kind === "heard-beep" ? ["yes", "no"] : ["done"];
  return source.map((value) => ({ value, label: choiceLabel(value, plan) }));
}

export function promptFor(
  ask: Extract<DeviceLine, { t: "ask" }>,
  plan: SelfTestPlan,
): { title: string; body: string; choices: PromptChoice[] } {
  const label = subjectLabel(ask, plan);
  let title: string;
  let body: string;
  switch (ask.kind) {
    case "press-hold":
      title = "Try the button";
      body = `Press and hold the ${label}, then tap Done`;
      break;
    case "release":
      title = "Release the button";
      body = `Let go of the ${label}, then tap Done`;
      break;
    case "cover":
      title = "Cover the light sensor";
      body = `Cover the ${label}, then tap Done`;
      break;
    case "uncover":
      title = "Uncover the light sensor";
      body = `Uncover the ${label}, then tap Done`;
      break;
    case "knob-min":
      title = "Turn the knob down";
      body = `Turn the ${label} all the way down, then tap Done`;
      break;
    case "knob-max":
      title = "Turn the knob up";
      body = `Turn the ${label} all the way up, then tap Done`;
      break;
    case "which-led":
      title = "Watch the blinking light";
      body = "Which light is blinking? 1 is the leftmost";
      break;
    case "heard-beep":
      title = "Listen for the buzzer";
      body = `Did you hear a beep from the ${label}?`;
      break;
    case "confirm":
      title = "Confirm what you see";
      body = `Check the ${label}, then tap Done`;
      break;
  }
  return { title, body, choices: choicesFor(ask, plan) };
}
