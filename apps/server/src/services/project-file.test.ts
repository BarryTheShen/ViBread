import { GOLDEN } from "@vibread/fixtures";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { RevisionResults } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { testDeps } from "../agents/testing.js";
import {
  createProjectFileService,
  parseProjectFile,
  PROJECT_MAX_ENTRIES,
  PROJECT_MAX_UNCOMPRESSED_BYTES,
  type ProjectFileDependencies,
} from "./project-file.js";

const fixture = GOLDEN.find((golden) => golden.key === "moon-phase-lamp")!;
const AUTHOR = { kind: "system" as const, id: "fixture", channel: "system" as const };

function fakePipeline(store: ProjectFileDependencies["store"]): ProjectFileDependencies["pipeline"] {
  return {
    async evaluate(missionId, n) {
      const result: RevisionResults = {
        reports: [
          {
            console: "EECOM",
            verdict: "GO",
            summary: "Electrical checks passed",
            findings: [],
            revisionHash: (await store.getRevision(missionId, n))!.hash,
            at: "2026-09-26T00:00:00.000Z",
          },
        ],
        artifacts: { "schematic.svg": await store.putArtifact("<svg />", "image/svg+xml") },
      };
      await store.saveResults(missionId, n, result);
      return result;
    },
    async idle() {},
  };
}

async function setup() {
  const deps = testDeps();
  const mission = await deps.store.createMission({ title: fixture.circuit.title, brief: fixture.brief, ownerId: "operator", inventory: fixture.inventory });
  const revision = await deps.store.createRevision(mission.id, { circuit: fixture.circuit, suite: fixture.suite, author: AUTHOR, note: "fixture" });
  await deps.store.updateMission(mission.id, { currentRevision: revision.n, phase: "GONOGO" });
  await deps.messages.save(mission.id, [
    {
      id: "recorded-user",
      role: "user",
      parts: [{ type: "text", text: "Build this with my kit." }, { type: "file", url: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }],
      metadata: { vibread: { recorded: { label: "Recorded run · Claude Opus 5.5 · Sep 26", model: "claude-opus-5-5", recordedAt: "2026-09-26T10:08:58-05:00" } } },
    },
  ]);
  await deps.store.appendEvent({ missionId: mission.id, channel: "system", actor: AUTHOR, kind: "mission.recorded", text: "Recording of a real Claude run (Sep 26) — not live", data: { label: "Recorded run · Claude Opus 5.5 · Sep 26", ownerId: "do-not-export", owner_id: "do-not-export", password: "secret", private_key: "secret", api_key: "secret" } });
  await deps.store.appendEvent({ missionId: mission.id, channel: "web", actor: AUTHOR, kind: "build.step", text: "Step 1 done", revision: 1, data: { n: 1 } });
  await deps.store.appendEvent({ missionId: mission.id, channel: "web", actor: AUTHOR, kind: "build.wire-color", text: "Wire W1 set to purple", revision: 1, data: { key: "wire:W1", color: "purple" } });
  const pipeline = fakePipeline(deps.store);
  await pipeline.evaluate(mission.id, revision.n);
  const service = createProjectFileService({ ...deps, pipeline });
  return { deps, mission, revision, service };
}

function replaceProject(bytes: Uint8Array, mutate: (project: Record<string, unknown>) => void): Uint8Array {
  const files = unzipSync(bytes);
  const project = JSON.parse(strFromU8(files["project.json"]!)) as Record<string, unknown>;
  mutate(project);
  const zip: Zippable = { ...files, "project.json": strToU8(JSON.stringify(project)) };
  return zipSync(zip);
}

describe("portable project files", () => {
  it("round-trips the mission, revisions, server-held chat, recorded label, wire colours, and re-derived artifacts", async () => {
    const source = await setup();
    const exported = await source.service.export(source.mission.id);
    expect(exported.fileName).toMatch(/\.vibread$/);
    const parsed = parseProjectFile(exported.bytes);
    const projectJson = strFromU8(unzipSync(exported.bytes)["project.json"]!);
    expect(projectJson.toLowerCase()).not.toMatch(/ownerid|owner_id|credential|token|handle|linkcode|email|password|private_key|api_key/);

    const sourceRevision = await source.deps.store.getRevision(source.mission.id, 1);
    const importedDeps = testDeps();
    const imported = createProjectFileService({ ...importedDeps, pipeline: fakePipeline(importedDeps.store) });
    const result = await imported.import({ bytes: exported.bytes, ownerId: "new-owner", fileName: "Moon lamp.vibread" });
    const mission = await importedDeps.store.getMission(result.missionId);
    expect(mission).toMatchObject({ title: source.mission.title, brief: source.mission.brief, ownerId: "new-owner", currentRevision: 1 });
    const revision = await importedDeps.store.getRevision(result.missionId, 1);
    expect(revision?.circuit).toEqual(source.revision.circuit);
    expect(revision?.suite).toEqual(source.revision.suite);
    expect(revision?.results.reports).toEqual(sourceRevision?.results.reports);
    expect((await importedDeps.messages.list(result.missionId))[0]?.parts).toEqual((await source.deps.messages.list(source.mission.id))[0]?.parts.map((part) => part.type === "file" ? { ...part, url: expect.stringMatching(/^data:image/) } : part));
    expect((await importedDeps.store.listEvents(result.missionId)).some((event) => event.kind === "project.imported" && event.text.includes("Moon lamp.vibread"))).toBe(true);
    expect((await importedDeps.store.listEvents(result.missionId)).some((event) => event.kind === "mission.recorded")).toBe(true);
    expect((await importedDeps.store.listEvents(result.missionId)).some((event) => {
      const data = event.data;
      return event.kind === "build.wire-color" && typeof data === "object" && data !== null && !Array.isArray(data) && "color" in data && data.color === "purple";
    })).toBe(true);
    expect(revision?.results.artifacts["schematic.svg"]).toBeTruthy();
    expect((await importedDeps.store.getArtifact(revision!.results.artifacts["schematic.svg"]!))?.contentType).toBe("image/svg+xml");
    expect((await importedDeps.store.getArtifact(revision!.results.artifacts["schematic.svg"]!))?.data).toEqual((await source.deps.store.getArtifact(sourceRevision!.results.artifacts["schematic.svg"]!))?.data);
    expect(parsed.document.buildProgress.done).toEqual([1]);
    expect(parsed.document.wireColors).toEqual({ "wire:W1": "purple" });
    expect((await importedDeps.messages.list(result.missionId))).toHaveLength(1);
  });

  it("accepts its own export whatever order the JSON keys come back in (a real store returns rows in column order)", async () => {
    const source = await setup();
    const exported = (await source.service.export(source.mission.id)).bytes;
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reversed(inner)]))
          : value;
    const reordered = replaceProject(exported, (project) => {
      for (const key of Object.keys(project)) delete project[key];
      Object.assign(project, reversed(JSON.parse(strFromU8(unzipSync(exported)["project.json"]!))));
    });
    const deps = testDeps();
    const service = createProjectFileService({ ...deps, pipeline: fakePipeline(deps.store) });
    const result = await service.import({ bytes: reordered, ownerId: "operator", fileName: "reordered.vibread" });
    expect((await deps.store.getMission(result.missionId))?.title).toBe(source.mission.title);
  });

  it("rejects tampering, wrong format, newer versions, oversized archives, and entry bombs", async () => {
    const source = await setup();
    const bytes = (await source.service.export(source.mission.id)).bytes;
    const cases: Array<[string, Uint8Array, string]> = [
      ["tampered", replaceProject(bytes, (project) => {
        const mission = project.mission;
        if (typeof mission !== "object" || mission === null || Array.isArray(mission)) throw new Error("test project mission missing");
        project.mission = { ...mission, title: "Changed" };
      }), "This file isn't a ViBread project"],
      ["wrong format", replaceProject(bytes, (project) => { project.format = "not-vibread"; }), "This file isn't a ViBread project"],
      ["newer", replaceProject(bytes, (project) => { project.version = 99; }), "This project was made by a newer ViBread (format v99)"],
      ["hash removed", replaceProject(bytes, (project) => { delete project.integrity; }), "This file isn't a ViBread project"],
    ];
    const tooMany: Zippable = { ...unzipSync(bytes) };
    for (let index = 0; index <= PROJECT_MAX_ENTRIES; index++) tooMany[`unknown-${index}`] = strToU8("x");
    cases.push(["too many", zipSync(tooMany), "This project has too many files"]);
    cases.push([
      "too large",
      zipSync({ ...unzipSync(bytes), "attachments/huge.bin": new Uint8Array(PROJECT_MAX_UNCOMPRESSED_BYTES + 1) }),
      "This project is too large when unpacked (maximum 100 MB)",
    ]);

    for (const [name, archive, message] of cases) {
      const deps = testDeps();
      const service = createProjectFileService({ ...deps, pipeline: fakePipeline(deps.store) });
      await expect(service.import({ bytes: archive, ownerId: "operator", fileName: `${name}.vibread` })).rejects.toThrow(message);
    }
  }, 30_000);
});
