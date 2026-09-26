import { GOLDEN } from "@vibread/fixtures";
import type { Actor, InventoryEntry, PartType } from "@vibread/core";
import { createUserTools, invokeTool } from "@vibread/tools";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "./index.js";
import { designSystemPrompt } from "./prompts.js";
import { memoryInventory, mockModels, scriptedDesign, scriptedJson, testDeps } from "./testing.js";

const golden = GOLDEN.find((g) => g.key === "moon-phase-lamp")!;
const OWNER: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };
const now = new Date().toISOString();

function entry(id: string, typeId: string, values: InventoryEntry["values"], quantity: number, status: InventoryEntry["status"] = "ready"): InventoryEntry {
  return { id, typeId, values, quantity, status, source: "typed", createdAt: now, updatedAt: now };
}

const USER_TILT: PartType = {
  id: "u-tilt",
  name: "Mercury-free tilt switch",
  category: "switches",
  aliases: [],
  photoHint: "A small metal cylinder with two legs.",
  description: "Closes when tipped over.",
  fields: [],
  support: "basic",
  mapping: { kind: "generic", role: "digital-sensor" },
  pinout: [
    { id: "1", name: "leg 1", etype: "passive" },
    { id: "2", name: "leg 2", etype: "passive" },
  ],
  builtIn: false,
};

function runtimeWith(entries: InventoryEntry[], types: PartType[] = []) {
  const deps = testDeps();
  const inventory = memoryInventory({ entries: { operator: entries }, types: { operator: types } });
  const runtime = createAgentRuntime({ ...deps, inventory, models: mockModels(scriptedDesign([]), scriptedJson([])) });
  return { deps, runtime, inventory };
}

describe("inventory → mission (plan §5.4)", () => {
  const ENTRIES = [
    entry("e-led", "led", { color: "yellow", size: "5 mm" }, 5),
    entry("e-r220", "resistor", { ohms: 220 }, 10),
    entry("e-ntc", "ntc-thermistor", {}, 1),
    entry("e-servo", "servo", {}, 1),
    entry("e-tilt", "u-tilt", {}, 2),
    entry("e-unsure", "resistor", { ohms: 10000 }, 4, "needs-look"),
  ];

  it("create without parts copies the owner's ready entries through each type's mapping; list-only become notes", async () => {
    const { runtime } = runtimeWith(ENTRIES, [USER_TILT]);
    const mission = await runtime.missions.create({ brief: golden.brief, owner: OWNER });
    const byModule = (m: string) => mission.inventory.filter((i) => i.module === m);
    expect(byModule("led")).toEqual([expect.objectContaining({ count: 5, params: expect.objectContaining({ color: "yellow" }) })]);
    expect(byModule("resistor")).toEqual([expect.objectContaining({ count: 10, params: expect.objectContaining({ ohms: 220 }) })]); // needs-look skipped
    expect(byModule("photoresistor")).toEqual([expect.objectContaining({ count: 1, label: expect.stringContaining("modelled as") })]);
    expect(byModule("generic")).toEqual([
      expect.objectContaining({ count: 2, label: "Mercury-free tilt switch", pinout: USER_TILT.pinout, params: expect.objectContaining({ role: "digital-sensor" }) }),
    ]);
    expect(mission.inventoryNotes?.join("\n")).toMatch(/servo/i);
  });

  it("inventoryEntryIds limits the copy; explicit inventory wins over the owner's entries", async () => {
    const { runtime } = runtimeWith(ENTRIES, [USER_TILT]);
    const limited = await runtime.missions.create({ brief: golden.brief, owner: OWNER, inventoryEntryIds: ["e-led"] });
    expect(limited.inventory.map((i) => i.module)).toEqual(["led"]);
    expect(limited.inventoryNotes).toBeUndefined();
    const explicit = await runtime.missions.create({ brief: golden.brief, owner: OWNER, inventory: golden.inventory });
    expect(explicit.inventory).toEqual(golden.inventory);
  });

  it("the design prompt carries labels, pinouts to copy, and the also-owns notes", async () => {
    const { runtime } = runtimeWith(ENTRIES, [USER_TILT]);
    const mission = await runtime.missions.create({ brief: golden.brief, owner: OWNER });
    const prompt = designSystemPrompt({ mission, revision: null });
    expect(prompt).toContain('the user\'s part "Mercury-free tilt switch": copy this label into the circuit part');
    expect(prompt).toContain('pinout (copy it into the part\'s "pinout" exactly): [{"id":"1","name":"leg 1","etype":"passive"},{"id":"2","name":"leg 2","etype":"passive"}]');
    expect(prompt).toContain("Also owns (ViBread can't design with these");
    expect(prompt).toMatch(/- .*servo/i);
  });

  it("add_part adds directly and says 'not in your inventory' only for parts the mission doesn't have", async () => {
    const { deps, runtime } = runtimeWith(ENTRIES, [USER_TILT]);
    const mission = await runtime.missions.create({ brief: golden.brief, owner: OWNER });
    const add = async (args: unknown) => {
      const result = await invokeTool({ registry: runtime.tools, broker: deps.broker, store: deps.store, ctx: { missionId: mission.id, actor: OWNER }, name: "add_part", args });
      return result.status === "executed" ? (result.output as { summary: string; inInventory: boolean }) : undefined;
    };
    expect(await add({ module: "buzzer-active", count: 1 })).toMatchObject({ inInventory: false, summary: expect.stringContaining("not in your inventory") });
    expect(await add({ module: "led", count: 1, params: { color: "yellow" } })).toMatchObject({ inInventory: true, summary: expect.not.stringContaining("not in your inventory") });
    expect(await add({ module: "led", count: 1, params: { color: "blue" } })).toMatchObject({ inInventory: false });
    expect(deps.broker.all()).toEqual([]);
  });

  it("vibread_get_inventory groups the owner's entries by type with support levels", async () => {
    const inventory = memoryInventory({ entries: { operator: ENTRIES }, types: { operator: [USER_TILT] } });
    const [tool] = createUserTools({ inventory });
    expect([tool!.name, tool!.actionClass]).toEqual(["vibread_get_inventory", "read-only"]);
    const out = (await tool!.handler({ ownerId: "operator" }, {})) as { summary: string; groups: { typeId: string; support: string; total: number; entries: { status: string }[] }[] };
    const group = (id: string) => out.groups.find((g) => g.typeId === id);
    expect(group("resistor")).toMatchObject({ support: "full", total: 14 });
    expect(group("resistor")!.entries.map((e) => e.status).sort()).toEqual(["needs-look", "ready"]);
    expect(group("ntc-thermistor")).toMatchObject({ support: "modelled", modelledAs: "Light sensor (photoresistor)" });
    expect(group("servo")).toMatchObject({ support: "list-only" });
    expect(group("u-tilt")).toMatchObject({ support: "basic", total: 2 });
    expect(out.summary).toContain("1 need a look");
    expect(await tool!.handler({ ownerId: "someone-else" }, {})).toMatchObject({ summary: "The inventory is empty", groups: [] });
  });
});
