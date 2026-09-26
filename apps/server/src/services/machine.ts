import { assign, createActor, createMachine } from "xstate";
import type { ActorRefFrom } from "xstate";
import type { MissionPhase, MissionStore } from "@vibread/core";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { DB } from "../db/schema.js";

export type MissionEvent =
  | { type: "BRIEF_RECEIVED" }
  | { type: "NEEDS_CLARIFICATION" }
  | { type: "DESIGN_STARTED" }
  | { type: "DESIGN_READY"; revision: number }
  | { type: "RELEASED"; revision: number }
  | { type: "BUILD_STEP"; n: number }
  | { type: "BUILD_DONE" }
  | { type: "VERIFY_STARTED" }
  | { type: "VERIFY_PASSED" }
  | { type: "VERIFY_FAILED" }
  | { type: "FIX_PROPOSED"; revision: number }
  | { type: "LAUNCHED" }
  | { type: "USER_CONFIRMED" };

export interface MissionMachine {
  phase(missionId: string): Promise<MissionPhase>;
  send(missionId: string, event: MissionEvent): Promise<MissionPhase>;
}

interface MachineContext {
  revision?: number;
}

const machine = createMachine({
  id: "vibread-mission",
  initial: "BRIEF",
  types: {} as { context: MachineContext; events: MissionEvent },
  context: {},
  states: {
    BRIEF: {
      on: {
        BRIEF_RECEIVED: "CLARIFY",
        NEEDS_CLARIFICATION: "CLARIFY",
        DESIGN_STARTED: "DESIGN",
      },
    },
    CLARIFY: {
      on: { DESIGN_STARTED: "DESIGN" },
    },
    DESIGN: {
      on: {
        DESIGN_READY: { target: "GONOGO", actions: assign({ revision: ({ event }) => event.revision }) },
        NEEDS_CLARIFICATION: "CLARIFY",
      },
    },
    GONOGO: {
      on: {
        RELEASED: { target: "ASSEMBLE", actions: assign({ revision: ({ event }) => event.revision }) },
        DESIGN_STARTED: "DESIGN",
      },
    },
    ASSEMBLE: {
      on: {
        BUILD_STEP: "ASSEMBLE",
        BUILD_DONE: "VERIFY",
        VERIFY_STARTED: "VERIFY",
      },
    },
    VERIFY: {
      on: {
        VERIFY_PASSED: "LAUNCH",
        VERIFY_FAILED: "DEBUG",
      },
    },
    DEBUG: {
      on: {
        FIX_PROPOSED: { target: "DESIGN", actions: assign({ revision: ({ event }) => event.revision }) },
        VERIFY_STARTED: "VERIFY",
      },
    },
    LAUNCH: {
      on: {
        LAUNCHED: "DONE",
        USER_CONFIRMED: "DONE",
      },
    },
    DONE: { type: "final" },
  },
});

export interface MissionMachineDependencies {
  db: DB;
  sqlite: SqliteDatabase;
  store: MissionStore;
}

export class PersistentMissionMachine implements MissionMachine {
  constructor(private readonly deps: MissionMachineDependencies) {}

  async phase(missionId: string): Promise<MissionPhase> {
    const mission = await this.deps.store.getMission(missionId);
    if (!mission) throw new Error("mission not found");
    const actor = this.actorFor(this.snapshotFor(missionId));
    const value = this.phaseFor(actor.getSnapshot().value);
    actor.stop();
    if (mission.phase !== value) await this.persist(missionId, this.snapshotFor(missionId), value);
    return value;
  }

  async send(missionId: string, event: MissionEvent): Promise<MissionPhase> {
    const mission = await this.deps.store.getMission(missionId);
    if (!mission) throw new Error("mission not found");
    const actor = this.actorFor(this.snapshotFor(missionId));
    const before = this.phaseFor(actor.getSnapshot().value);
    actor.send(event);
    const snapshot = actor.getPersistedSnapshot();
    const after = this.phaseFor(actor.getSnapshot().value);
    actor.stop();
    await this.persist(missionId, snapshot, after);
    if (before !== after || event.type === "BUILD_STEP") {
      await this.deps.store.appendEvent({
        missionId,
        channel: "system",
        actor: { kind: "system", id: "machine", channel: "system" },
        kind: "phase.changed",
        text: machineEventText(event, before, after),
        revision: "revision" in event ? event.revision : mission.currentRevision,
        data: { event, from: before, to: after },
      });
    }
    return after;
  }

  private snapshotFor(missionId: string): unknown | undefined {
    const row = this.deps.sqlite.prepare('SELECT "snapshot" FROM "missions" WHERE "id" = ?').get(missionId) as { snapshot: string | null } | undefined;
    if (!row?.snapshot) return undefined;
    return JSON.parse(row.snapshot) as unknown;
  }

  private actorFor(snapshot: unknown): ActorRefFrom<typeof machine> {
    const actor = snapshot === undefined
      ? createActor(machine)
      : createActor(machine, { snapshot: snapshot as never });
    actor.start();
    return actor;
  }

  private async persist(missionId: string, snapshot: unknown, phase: MissionPhase): Promise<void> {
    this.deps.sqlite
      .prepare('UPDATE "missions" SET "snapshot" = ?, "phase" = ?, "updatedAt" = ? WHERE "id" = ?')
      .run(JSON.stringify(snapshot), phase, Date.now(), missionId);
  }

  private phaseFor(value: unknown): MissionPhase {
    if (typeof value !== "string") throw new Error("invalid mission machine state");
    return value as MissionPhase;
  }
}

function machineEventText(event: MissionEvent, before: MissionPhase, after: MissionPhase): string {
  switch (event.type) {
    case "BRIEF_RECEIVED":
      return "Brief received — clarify the mission";
    case "NEEDS_CLARIFICATION":
      return "More details needed before design";
    case "DESIGN_STARTED":
      return "Design work started";
    case "DESIGN_READY":
      return `Design r${event.revision} is ready for the Go/No-Go poll`;
    case "RELEASED":
      return `Design r${event.revision} released — time to build`;
    case "BUILD_STEP":
      return `Build step ${event.n} complete — continue assembly`;
    case "BUILD_DONE":
      return "Build finished — ready to test on the real board";
    case "VERIFY_STARTED":
      return "Physical verification started";
    case "VERIFY_PASSED":
      return "Self-test passed — ready to launch";
    case "VERIFY_FAILED":
      return "Houston, we have a problem — debugging";
    case "FIX_PROPOSED":
      return `Fix proposed for revision r${event.revision} — back to design`;
    case "LAUNCHED":
    case "USER_CONFIRMED":
      return "Mission launched — circuit is ready";
    default:
      return `${before} → ${after}`;
  }
}

export function createMissionMachine(deps: MissionMachineDependencies): MissionMachine {
  return new PersistentMissionMachine(deps);
}
