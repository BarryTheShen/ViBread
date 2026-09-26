# End-to-end benchmark with real Claude models

**Status (Sat Sep 26, 2026, 12:40 CDT): 3 of 10 briefs measured.** The three golden briefs ran the whole chain on real
models. The seven new beginner briefs are blocked until the omp Claude credential on this machine is restored (see
[Failures](#failures-and-what-they-mean)). The harness is ready to finish them with one command.

Worktree commit `dc69110`. Harness: [`scripts/e2e-benchmark.mts`](../scripts/e2e-benchmark.mts). Raw results:
`/tmp/promptlab-e2e/run1/<brief>/result.json`, design transcripts `design-*.jsonl`, and `summary.md`.

## Headline (3 golden briefs)

- **3/3 briefs reached five GO consoles** (EECOM, GUIDO, FIDO, FAO, RETRO) and were released by GO for build.
- **Design time:** median 308 s (126–363 s). This includes the test author and RETRO, which run inside every
  propose_design. propose_design calls: 1, 2, 2.
- **Independent tests:** 18/18 model-written scenarios passed on the compiled firmware, and coverage was complete for all 3.
- **RETRO:** 3/3 GO. Each vote says it traced the sketch by hand against the brief.
- **Build:** 7–15 jumpers, 17–33 numbered steps; everything fits on a bb-830 and LVS is clean.
- **Virtual bench self-test on the released revision:** 3/3 pass.
- **Injected wiring fault:** caught 3/3, true cause ranked first 3/3 (top-1 = 3/3).
- **Cost:** about $2.02 total, 732k tokens, ≈ $0.67 per brief. These are omp's usage and list-price figures for Opus
  5.5 plus Sonnet 5.

## Method

One command runs the whole chain and writes every number in this document:

```bash
npx tsx scripts/e2e-benchmark.mts [--only key,…] [--resume key,…] [--parallel 1] [--out /tmp/promptlab-e2e/<run>]
```

It needs the `omp` CLI with Anthropic model access, the Arduino toolchain, and ports 8950 (ViBread) and 8951 (bridge). It
starts its own ViBread server with a fresh `DATA_DIR`. `--resume` re-runs only GO for build and the bench for briefs
whose design already ran.

| Step | What runs | Real? What the harness does |
|---|---|---|
| Mission | `POST /api/missions` with the brief and a realistic "parts I have" list, Review mode | Real ViBread REST |
| Design agent | **Claude Opus 5.5** (`anthropic/claude-opus-5-5`) in `omp -p`, the way a user's Claude Code would connect. Its prompt starts with ViBread's exact `designSystemPrompt(mission)` text. It uses ViBread's tools over **MCP** with a bearer token from `POST /api/connections/tokens` | Real model, real MCP server. The harness uses omp instead of Claude Code and restricts omp's own tools to read/write (omp exposes MCP tools as `xd://` devices: read shows the schema, write makes the call). It also disables omp's 30 s MCP request timeout, because one propose_design runs the test author and RETRO inline and takes minutes. MCP has no `ask_user`, so an ask-back would be the agent's final reply, and the harness would answer once with "You decide — go with what you think is best" (none of the 3 briefs asked back) |
| Consoles | Every propose_design runs EECOM, GUIDO (arduino-cli compile plus simulated pin modes), the independent test author and then FIDO (ATmega328P simulator on the compiled HEX plus coverage rules), FAO (layout, LVS, steps) and RETRO | All ViBread's own code, including `test-author.ts` (TestSuiteSchema parse and one coverage-repair round), `retro.ts` and the fault dictionary |
| Test author, RETRO | **Claude Sonnet 5** (`anthropic/claude-sonnet-5`) with the production prompts and code. ViBread's server calls Anthropic through the AI SDK. The harness sets `ANTHROPIC_BASE_URL` to a local Anthropic Messages endpoint (the "bridge"), which runs each request as one `omp -p` call on the requested model with the request's system prompt and user text | Real model. The bridge is harness. **Caveat:** omp has no structured-output flag, so the bridge appends the request's JSON Schema to the prompt and takes the JSON object from the reply. Production uses Anthropic's native structured outputs, which guarantee the schema; here ViBread's zod parse is the check, and it never failed |
| GO for build | `POST /api/missions/:id/release` as the Flight Director. There is no waiver: a credential exists, so RETRO must vote GO | Real release gates |
| Virtual bench | The server compiles the self-test firmware and plans the self-test (`POST …/bench/firmware {kind:"bench"}`). That firmware runs in ViBread's simulator on the as-designed circuit with a scripted person. `POST …/bench/runs` has the server evaluate and diagnose, with the fault dictionary merged once `faults.json` is ready (it was ready for all 3) | Real firmware, simulator, evaluator and diagnosis. The person is harness: presses and covers when asked, reports which LED is actually lit, says whether the buzzer beeped |
| Injected fault | `applyFault` on the released layout: button-leg-in-gnd-row if the design has a button, otherwise led-jumpers-swapped, otherwise led-missing. The as-built circuit runs the same bench firmware, the server diagnoses it, and "rank" is the true cause's position in the candidate list | Real diagnosis; the fault is simulated |

Timing is wall clock on the shared team machine, with 3 briefs running in parallel for these results. From now on the
harness runs one design at a time (see Failures).

## Results

| Brief | Design time | Tool calls | propose_design | First all-GO rev | Consoles (final) | FIDO | RETRO | Jumpers / steps / board | Release | Virtual self-test | Injected fault → diagnosis | Total | Tokens / cost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| moon-phase-lamp | 363 s | 12 | 2 | 2 | all 5 GO | 8/8 | GO | 15 / 33 / bb-830 | r2 | pass | button-leg-in-gnd-row: caught, rank 1 | 423 s | 395k / $0.91 |
| knob-night-light | 126 s | 4 | 1 | 1 | all 5 GO | 4/4 | GO | 7 / 17 / bb-830 | r1 | pass | led-missing: caught, rank 1 | 143 s | 105k / $0.36 |
| launch-control | 308 s | 6 | 2 | 1 | all 5 GO | 6/6 | GO | 13 / 30 / bb-830 | r2 | pass | button-leg-in-gnd-row: caught, rank 1 | 326 s | 232k / $0.75 |
| traffic-light, reaction-game, knob-chaser, doorbell, dusk-lamp, sos-blinker, quick-press | pending | | | | | | | | | | | | |

"Total" is the design plus release, bench and fault run; the resumed bench runs add a few seconds. Tokens and cost are
the design agent plus the test-author and RETRO calls for that brief.

### What happened per brief

- **Moon-phase lamp.** Revision 1: EECOM, GUIDO and FAO GO, **FIDO NO-GO**. The model-written test T6 ("A bouncy button
  press only moves the moon forward one day") failed with "LED4 should be off … but was lit 100 %". The agent read the
  finding, ran the scenario and the coverage report, rewrote its debounce and proposed revision 2. The interface was
  unchanged, so the same tests were reused, and revision 2 passed 8/8 with RETRO GO. The independent test caught a real
  firmware bug and the agent fixed it on the next try.
  - RETRO: "Every clause in the brief and intent is honestly implemented and I hand-traced the sketch's phase math, pin
    roles, and debounce logic and they line up."
  - The agent chose a 30-day cycle (one press = one day) and stated that as an assumption.
- **Knob night-light.** Revision 1 got all five GO: 4/4 tests passed, and RETRO said "The knob correctly and smoothly
  sets the night-light's brightness from off to full…". The agent then requested release_revision, which waited for the
  human's GO for build.
- **Launch control.** Revision 1 already had all five GO. The agent called propose_design from omp's Python eval tool,
  whose 30 s cell timeout cut the call off on the agent's side while the server finished it. The agent couldn't see the
  result, checked status and proposed again (revision 2, all GO, 6/6).
  - RETRO: "ARM toggles the red light, LAUNCH is ignored unless armed, the 3-second countdown blinks yellow three times…
    liftoff turns on green and the buzzer together for one second."
  - This harness artifact is why the design has 2 attempts and took 308 s. Design runs are now limited to read/write.

## Failures and what they mean

1. **Blocker: omp's credential store was corrupted mid-run.** At 12:31:08 CDT, while the harness started three omp
   design runs within seconds of each other (alongside bridge calls), omp reported `~/.omp/agent/agent.db` corrupt. It
   moved the file aside (`agent.db.corrupt-…`, really malformed) and started with an empty credential store. Since then
   every new omp process fails with "No API key found for anthropic", so the seven new briefs failed in 2 s without
   reaching a model. Concurrent omp starts on this machine are the most likely cause.
   - Mitigation in the harness: `--parallel 1` is now the default, and omp processes start at least 5 s apart.
   - Recovery needs a human `omp login anthropic`.
2. **Moon virtual self-test first reported "incomplete". The harness caused it, not ViBread.** The LED check stalled
   after the third "Which light is blinking?" answer. The scripted person advanced the simulator (`session.run`) from
   inside the serial callback. That re-entrant call stalls the bench firmware's LED sequence depending on the design; it
   reproduces on the golden moon circuit just by listing the A0 role before the LED roles. With the person answering
   between simulator slices instead, the same firmware passes. The harness now does this, and all 3 self-tests pass.
   - The same re-entrant pattern is in `packages/bench/src/faults.ts` (`runWithSession`, which builds the server's fault
     dictionary) and `virtual-bench.test.ts`. It may explain dictionary entries such as moon "wrong-resistor-value:
     incomplete, led.sequence unknown".
   - This was reported to the bench owner; the browser bench worker doesn't nest `run()`.
3. **First bench POSTs failed with "fetch failed" (harness).** The simulator blocks the harness's event loop for
   seconds, the server closed the idle keep-alive socket after 5 s, and undici reused it. Requests that never reached
   the server are now retried once.
4. **Launch control's second attempt** came from omp's eval timeout (above). It says nothing about ViBread.

No ViBread failures so far. Every console verdict, test result, release gate, self-test and diagnosis in the three
completed briefs was produced by ViBread's own code on real model output.

## Pending: the seven new briefs

Each brief has a realistic parts list in the harness, using only library parts:

- **traffic-light:** red, yellow and green lights with a walk button
- **reaction-game:** LED, button and active buzzer
- **knob-chaser:** five LEDs whose chase speed follows a potentiometer
- **doorbell:** ding-dong on a passive buzzer, with a blinking light
- **dusk-lamp:** photoresistor and a PWM fade
- **sos-blinker:** Morse SOS started and stopped with a button
- **quick-press:** two-player game with three buttons, LEDs and a buzzer

To finish once omp can log in again:

```bash
npx tsx scripts/e2e-benchmark.mts --out /tmp/promptlab-e2e/run1 --data-dir /tmp/promptlab-e2e/data \
  --only traffic-light,reaction-game,knob-chaser,doorbell,dusk-lamp,sos-blinker,quick-press
```

The table in `summary.md` then covers all 10 briefs.
