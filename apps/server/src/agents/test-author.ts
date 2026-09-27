import { SIM_SCHEMA, ScenarioSchema, TestSuiteSchema, type MissionStore, type Scenario, type TestSuite } from "@vibread/core";
import { ToolInputError, type RegistryHooks, type TestReview } from "@vibread/tools";
import { z } from "zod";
import type { AgentModels } from "./models.js";
import { completeObject } from "./pi-object.js";
import { TEST_AUTHOR_SYSTEM, TEST_REVIEW_SYSTEM, testAuthorPrompt, testReviewPrompt } from "./prompts.js";

const MAX_ATTEMPTS = 2;

/** A scenario as the test author writes it: `setAside` is ViBread's (from the test review), never the author's. */
const AuthoredScenarioSchema = ScenarioSchema.omit({ setAside: true });

/** What the test author sends: the suite; the fixed header fields may be missing or off (ViBread sets them). */
const AuthoredSuiteSchema = TestSuiteSchema.extend({
  schema: z.string().optional().describe(`Always "${SIM_SCHEMA}".`),
  author: z.string().optional().describe('Always "test-author".'),
  scenarios: z.array(AuthoredScenarioSchema).min(1),
});

/** What the test author sends when reviewing its failing scenarios. */
const ReviewSchema = z.object({
  reviews: z.array(
    z.object({
      id: z.string().regex(/^T\d+$/).describe("The failing scenario's id."),
      verdict: z.enum(["test-wrong", "design-wrong", "unsure"]),
      reason: z.string().min(1).describe("One or two sentences citing the intent clause and the timeline."),
      scenario: AuthoredScenarioSchema.optional().describe('For "test-wrong": the corrected scenario (same id and clauses).'),
    }),
  ),
});

/** Kept scenarios first, then the new ones, renumbered where an id is already taken. */
function merge(keep: Scenario[], written: Scenario[]): Scenario[] {
  const taken = new Set(keep.map((s) => s.id));
  let next = Math.max(0, ...keep.map((s) => Number(s.id.slice(1)))) + 1;
  const fresh = written.map((s) => {
    if (!taken.has(s.id)) {
      taken.add(s.id);
      return s;
    }
    while (taken.has(`T${next}`)) next++;
    taken.add(`T${next}`);
    return { ...s, id: `T${next}` };
  });
  return [...keep, ...fresh];
}

/**
 * Independent test author (PLAN §5.6): brief + design interface → vibread.sim/v1 suite. Its input type has no sketch field,
 * so the firmware can't reach the prompt. With `keep`, it writes scenarios only for the changed clauses and the kept ones
 * are added back unchanged. One repair round when the coverage rules report gaps; if that round fails, the first suite
 * stands (FIDO then reports its coverage gaps). `review`: the same author judging its failing scenarios (issue #16).
 */
export function createTestAuthor(deps: { models: AgentModels; store: MissionStore }): { write: NonNullable<RegistryHooks["writeTests"]>; review: NonNullable<RegistryHooks["reviewTests"]> } {
  async function claudeFor(missionId: string) {
    const mission = await deps.store.getMission(missionId);
    if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
    return deps.models.fast(mission.ownerId, { missionId, purpose: "test-author" });
  }
  return {
    async write({ missionId, brief, design, coverageGaps, keep = [], clauses, signal }) {
      const claude = await claudeFor(missionId);
      let gaps: string[] = [];
      let suite: TestSuite | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && (!suite || gaps.length); attempt++) {
        const written = completeObject(claude, {
          system: TEST_AUTHOR_SYSTEM,
          content: testAuthorPrompt({ brief, design, gaps, ...(keep.length ? { keep, clauses: clauses ?? [] } : {}) }),
          schema: AuthoredSuiteSchema,
          name: "test_suite",
          description: keep.length ? "Return only your new vibread.sim/v1 scenarios (the kept ones are added back)." : "Return the vibread.sim/v1 test suite.",
          ...(signal ? { signal } : {}),
        });
        const output = suite ? await written.catch(() => undefined) : await written;
        if (!output) break;
        suite = TestSuiteSchema.parse({ schema: SIM_SCHEMA, author: "test-author", scenarios: merge(keep, output.scenarios) });
        gaps = coverageGaps(suite);
      }
      if (!suite) throw new Error("The test author returned no suite.");
      return suite;
    },

    async review({ missionId, brief, design, failures, dispute, signal }): Promise<TestReview[]> {
      const claude = await claudeFor(missionId);
      const output = await completeObject(claude, {
        system: TEST_REVIEW_SYSTEM,
        content: testReviewPrompt({ brief, design, failures, ...(dispute ? { dispute } : {}) }),
        schema: ReviewSchema,
        name: "test_review",
        description: "Return one review per failing scenario.",
        ...(signal ? { signal } : {}),
      });
      return output.reviews.map((r) => ({ id: r.id, verdict: r.verdict, reason: r.reason, ...(r.scenario ? { scenario: r.scenario } : {}) }));
    },
  };
}
