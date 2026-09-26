import { isRecord } from "../lib/guards.js";

/** Plain-language labels for agent tools (packages/tools names). Unknown tools fall back to a generic label. */
export interface ToolLabel {
  active: string;
  done: string;
}

export const TOOL_LABELS: Record<string, ToolLabel> = {
  list_modules: { active: "Looking through the parts library…", done: "Looked through the parts library" },
  get_inventory: { active: "Checking which parts you have…", done: "Checked your parts" },
  propose_design: { active: "Designing the circuit and code…", done: "Proposed a design" },
  validate_ir: { active: "Making sure the design is complete…", done: "Checked the design is complete" },
  render_schematic: { active: "Drawing the schematic…", done: "Drew the schematic" },
  run_erc: { active: "Checking the circuit…", done: "Checked the circuit" },
  electrical_limits: { active: "Checking currents and voltages…", done: "Checked currents and voltages" },
  spice_crosscheck: { active: "Double-checking currents with a circuit simulator…", done: "Double-checked currents" },
  explain_finding: { active: "Explaining a check result…", done: "Explained a check result" },
  compile: { active: "Compiling the code…", done: "Compiled the code" },
  pin_mode_check: { active: "Checking the code matches the wiring…", done: "Checked the code matches the wiring" },
  generate_selftest: { active: "Preparing the board self-test…", done: "Prepared the board self-test" },
  run_scenarios: { active: "Running the simulation tests…", done: "Ran the simulation tests" },
  coverage_report: { active: "Checking the tests cover everything…", done: "Checked test coverage" },
  sim_trace: { active: "Recording a simulation replay…", done: "Recorded a simulation replay" },
  layout_board: { active: "Placing parts on the breadboard…", done: "Placed parts on the breadboard" },
  lvs_check: { active: "Checking the breadboard matches the schematic…", done: "Checked the breadboard matches the schematic" },
  build_steps: { active: "Writing the build steps…", done: "Wrote the build steps" },
  render_step_png: { active: "Drawing a build step…", done: "Drew a build step" },
  diagnose: { active: "Working out what went wrong…", done: "Worked out what went wrong" },
  inspect_photo: { active: "Looking at your photo…", done: "Looked at your photo" },
  explain_telemetry: { active: "Reading the board's test results…", done: "Read the board's test results" },
  release_revision: { active: "Releasing the design for building…", done: "Released the design for building" },
  request_bench_action: { active: "Asking for a bench action…", done: "Bench action requested" },
  add_part: { active: "Adding a part…", done: "Added a part" },
  ask_user: { active: "Preparing a question…", done: "Asked you a question" },
};

/**
 * Label for a tool call; `input` names the design version where the tool has one ("Released design r2"). A tool part
 * can arrive without its name (e.g. its output streams in after a reconnect); it is labelled generically.
 */
export function toolLabel(toolName: string | undefined, input?: unknown): ToolLabel {
  if (!toolName) return { active: "Working…", done: "Finished a step" };
  const revision = isRecord(input) && typeof input.revision === "number" ? input.revision : undefined;
  if (toolName === "release_revision" && revision !== undefined) return { active: `Releasing design r${revision}…`, done: `Released design r${revision}` };
  return TOOL_LABELS[toolName] ?? { active: `Working (${toolName.replace(/_/g, " ")})…`, done: `Finished ${toolName.replace(/_/g, " ")}` };
}
