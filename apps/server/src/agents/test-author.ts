import { TestSuiteSchema, type TestSuite } from "@vibread/core";
import type { RegistryHooks } from "@vibread/tools";
import { Output, generateText } from "ai";
import type { AgentModels } from "./models.js";
import { TEST_AUTHOR_SYSTEM, testAuthorPrompt } from "./prompts.js";

const MAX_ATTEMPTS = 2;

/**
 * Independent test author (PLAN §5.6): brief + design interface → vibread.sim/v1 suite. Its input type has no sketch field,
 * so the firmware can't reach the prompt. One repair round when the coverage rules report gaps.
 */
export function createTestAuthor(deps: { models: AgentModels }): { write: NonNullable<RegistryHooks["writeTests"]> } {
  return {
    async write({ brief, design, coverageGaps, signal }) {
      const model = deps.models.fast();
      let gaps: string[] = [];
      let suite: TestSuite | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && (!suite || gaps.length); attempt++) {
        const result = await generateText({
          model,
          system: TEST_AUTHOR_SYSTEM,
          prompt: testAuthorPrompt({ brief, design, gaps }),
          output: Output.object({ schema: TestSuiteSchema, name: "test_suite", description: "vibread.sim/v1 test suite" }),
          ...(signal ? { abortSignal: signal } : {}),
        });
        suite = TestSuiteSchema.parse({ ...result.output, author: "test-author" });
        gaps = coverageGaps(suite);
      }
      if (!suite) throw new Error("The test author returned no suite.");
      return suite;
    },
  };
}
