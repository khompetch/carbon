# Pulse Phase 3 — end-to-end run

**Plan:** .ai/plans/2026-11-16-pulse-phase3-automatic-quantities.md (Task 17)
**Date:** 2026-11-16
**Stack:** `crbn up` (ERP, MES, Inngest dev server), the `pulse` Mosquitto
broker, `pulse-ingest` and the device simulator, local database `wt_carbon`.

## Setup

- `crbn up` on Windows needs `npm_config_script_shell` set to Git Bash for the
  process: the root postinstall script is POSIX shell, and cmd.exe cannot run
  it. The variable was set for that one process only.
- The mapping was set to count mode Auto with SQL equal to the Counting form's
  save (`countMode`, `scrapReasonId`, `countedThrough = now()`), because the
  browser check was not available (see "Not run").
- Test data changes in the local database: the target of J000011's operation
  `jo_9ezUQ3wZSedjVJLnXbWxbr` was set to 1000, then 30; operations of J000001
  were loaded on the CNC Mill with Labor production events of the test user.

## Results

| # | Check | Result |
|---|---|---|
| 1 | 10 strokes at 2 pieces per pulse, untracked operation | Pass: one Production posting of 20; `quantityComplete` 0 → 20 |
| 2 | 3 strokes, then 1 Log scrap press | Pass: Production +4, Scrap +2 (in-batch net) |
| 3 | 1 Log scrap press after the strokes posted | Pass: Production lowered 24 → 22, Scrap 2 → 4 (`reclassify`) |
| 4 | Manual Log completed in the MES in Auto | Not run (browser) |
| 5 | MES Log scrap with "Counted by the sensor" | Not run (browser) |
| 6 | 8 strokes (16 pieces) with 8 left to a target of 30 | Pass: posted 8, operation Done, 8 queued as `OverTarget` |
| 7 | Strokes with no operation loaded | Pass: queued as `NoLoad`; assign from the drawer not run (browser) |
| 8 | Batch item, label every N | Not run: the demo data has no active batch job. `batchLabelCount` is unit-tested |
| 9 | Serial item with send each pulse | Pass: 1 stroke → 2 units Available with the operation marker, next unit spawned, 2 print jobs completed. A Log scrap press scrapped both units of the stroke, removed their completions (2 → 0) and spawned 2 replacements |
| 10 | Repeated bucket, network drop and replay | Covered by the Phase 1 simulator run and the ingest tests; not repeated |

Other findings:

- A bucket on the TIG cell went to the queue as `Blocked`: the demo data has an
  In Progress Down maintenance dispatch there. Correct behavior.
- J000001's first serial operation went Done at 2 of 3 complete because the
  demo data already held 1 Rework; the database counts complete + rework
  toward the target, and so does the poster.

## Fix made during the run

- The first serial posting took 40 s. Ingest wakes the sync once per bucket,
  and the count step skipped a bucket still inside its 10 s settle window, so
  the bucket waited for a later wake. Commit `ba9fd1806`: the step returns a
  recheck just after the newest unread bucket settles, and the window is 3 s.
  Measured after the fix: 7 s from the stroke to 2 posted serial units.

## Not run

Checks 4, 5 and the browser parts of 7: `agent-browser` is not installed on
this machine.
