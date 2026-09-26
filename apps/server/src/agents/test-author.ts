import { SIM_SCHEMA, TestSuiteSchema, type MissionStore, type TestSuite } from "@vibread/core";
import { ToolInputError, type RegistryHooks } from "@vibread/tools";
import { z } from "zod";
import type { AgentModels } from "./models.js";
import { completeObject } from "./pi-object.js";
import { TEST_AUTHOR_SYSTEM, testAuthorPrompt } from "./prompts.js";

const MAX_ATTEMPTS = 2;

/** What the test author sends: the suite; the fixed header fields may be missing or off (ViBread sets them). */
const AuthoredSuiteSchema = TestSuiteSchema.extend({
  schema: z.string().optional().describe(`Always "${SIM_SCHEMA}".`),
  author: z.string().optional().describe('Always "test-author".'),
});

/**
 * Independent test author (PLAN §5.6): brief + design interface → vibread.sim/v1 suite. Its input type has no sketch field,
 * so the firmware can't reach the prompt. One repair round when the coverage rules report gaps; if that round fails, the
 * first suite stands (FIDO then reports its coverage gaps).
 */
export function createTestAuthor(deps: { models: AgentModels; store: MissionStore }): { write: NonNullable<RegistryHooks["writeTests"]> } {
  return {
    async write({ missionId, brief, design, coverageGaps, signal }) {
      const mission = await deps.store.getMission(missionId);
      if (!mission) throw new ToolInputError(`Mission ${missionId} does not exist.`, 404);
      const claude = await deps.models.fast(mission.ownerId, { missionId, purpose: "test-author" });
      let gaps: string[] = [];
      let suite: TestSuite | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && (!suite || gaps.length); attempt++) {
        const written = completeObject(claude, {
          system: TEST_AUTHOR_SYSTEM,
          content: testAuthorPrompt({ brief, design, gaps }),
          schema: AuthoredSuiteSchema,
          name: "test_suite",
          description: "Return the vibread.sim/v1 test suite.",
          ...(signal ? { signal } : {}),
        });
        const output = suite ? await written.catch(() => undefined) : await written;
        if (!output) break;
        suite = TestSuiteSchema.parse({ ...output, schema: SIM_SCHEMA, author: "test-author" });
        gaps = coverageGaps(suite);
      }
      if (!suite) throw new Error("The test author returned no suite.");
      return suite;
    },
  };
}
