# Pulse Phase 3 — end-to-end run

**Plan:** .ai/plans/2026-11-16-pulse-phase3-automatic-quantities.md (Task 17)
**Date:** 2026-11-16
**Stack:** `crbn up` (ERP, MES, Inngest dev server), the `pulse` Mosquitto
broker, `pulse-ingest` and the device simulator, local database `wt_carbon`.
The browser checks used `agent-browser` 0.43.0.

## Setup

- `crbn up` on Windows needs `npm_config_script_shell` set to Git Bash for the
  process: the root postinstall script is POSIX shell, and cmd.exe cannot run
  it. The variable was set for that one process only.
- For the backend checks, the mapping was set to count mode Auto with SQL equal
  to the Counting form's save (`countMode`, `scrapReasonId`,
  `countedThrough = now()`). The browser checks later used the form itself.
- Test data changes in the local database:
  - The target of J000011's operation `jo_9ezUQ3wZSedjVJLnXbWxbr` was set to
    1000, then 30.
  - Operations of J000001 were loaded on the CNC Mill with Labor production
    events of the test user.
  - J000001 "Machine structural panels" (`jo_2AjTbKnmaHz3d1wv4KbPdB`) got a
    Labor start in the MES, 1 overridden piece, 1 sensor piece and 1 scrap.
    Its `operationQuantity` was set to 10 and back to 3.

## Results

| # | Check | Result |
|---|---|---|
| 1 | 10 strokes at 2 pieces per pulse, untracked operation | Pass: one Production posting of 20; `quantityComplete` 0 → 20 |
| 2 | 3 strokes, then 1 Log scrap press | Pass: Production +4, Scrap +2 (in-batch net) |
| 3 | 1 Log scrap press after the strokes posted | Pass: Production lowered 24 → 22, Scrap 2 → 4 (`reclassify`) |
| 4 | Manual Log completed in the MES in Auto | Pass (browser): see "Browser checks" |
| 5 | MES Log scrap with "Counted by the sensor" | Pass (browser): see "Browser checks" |
| 6 | 8 strokes (16 pieces) with 8 left to a target of 30 | Pass: posted 8, operation Done, 8 queued as `OverTarget` |
| 7 | Strokes with no operation loaded | Pass: queued as `NoLoad`; assign and dismiss pass in the browser |
| 8 | Batch item, label every N | Not run: the demo data has no active batch job. `batchLabelCount` is unit-tested |
| 9 | Serial item with send each pulse | Pass: 1 stroke → 2 units Available with the operation marker, next unit spawned, 2 print jobs completed. A Log scrap press scrapped both units of the stroke, removed their completions (2 → 0) and spawned 2 replacements |
| 10 | Repeated bucket, network drop and replay | Covered by the Phase 1 simulator run and the ingest tests; not repeated |

## Browser checks

| Check | Result |
|---|---|
| ERP Counting form | Pass. Sim TIG Cell set to Off with "Print a label every N pieces" 10: the row holds `Off` and 10. Set back to Auto: `countedThrough` moves to the save time. A cleared label field saves null |
| Unattributed Counts list | Pass. 6 rows with the reasons NoLoad, Blocked (shown as "Maintenance") and OverTarget |
| Assign from the drawer | Pass. A NoLoad row of 2 pieces assigned to J000003 (untracked, target 1): 1 posted, the operation went Done, and 1 went back to the queue as `OverTarget`. The drawer moved to the next row |
| Dismiss | Pass. The row is deleted and the drawer moves to the next row |
| MES Log completed in Auto | Pass. The modal shows "This work center logs completed quantities from its sensor." and Log Completed is disabled. An override with no note is refused: "An override needs the supervisor permission and a note." An override with a note posts Production 1 with the note |
| MES Log scrap "Counted by the sensor" | Pass. With no sensor Production the scrap is refused: "The sensor has not counted that many pieces on this operation." After 2 sensor pieces, a scrap of 1 lowered the sensor Production 2 → 1 and posted Scrap 1; complete 3 → 2, the operation went back to Ready |

Other findings:

- A bucket on the TIG cell went to the queue as `Blocked`: the demo data has an
  In Progress Down maintenance dispatch there. Correct behavior.
- J000001's first serial operation went Done at 2 of 3 complete because the
  demo data already held 1 Rework; the database counts complete + rework
  toward the target, and so does the poster.
- The poster reads the target from `jobOperation.targetQuantity`, not
  `operationQuantity`. A raise of `operationQuantity` changed nothing.
- The MES reads the count mode from the operation's own work center. The poster
  follows the load. The two differ only when an operation starts on another
  work center; the test data did that through SQL.
- The Log completed modal closes on a refused submit. The operator sees the
  toast and must enter the values again.

## Fixes made during the run

- The first serial posting took 40 s. Ingest wakes the sync once per bucket,
  and the count step skipped a bucket still inside its 10 s settle window, so
  the bucket waited for a later wake. Commit `ba9fd1806`: the step returns a
  recheck just after the newest unread bucket settles, and the window is 3 s.
  Measured after the fix: 7 s from the stroke to 2 posted serial units.
- No MES page hydrated. `operations.service.ts` re-exported the first/last
  operation reads from `@carbon/printing/operation-label.server`, and MES
  components import that service. Vite refused the server-only module. The two
  reads moved to `@carbon/printing/operation-routing`, a browser-safe module
  (lesson in `.ai/lessons.md`).
- The actions menu of an Unattributed Counts row was named by a raw ISO time.
  The table now names it by the work center and the start time.

## Fixes after the self-review

The branch self-review found 4 defects. All 4 are fixed:

| # | Defect | Fix |
|---|---|---|
| 1 | An Unattributed Counts assign and a running count step could both read one row as `Pending` and post it twice | `postMachineCounts` holds a transaction advisory lock per work center while it posts |
| 2 | An over-target split wrote the `OverTarget` row and the smaller posting quantity in two statements | Both writes are one transaction |
| 3 | MES batch completion on a work center in Auto counted the pieces a second time | The route refuses a completed quantity above 0 |
| 4 | MES inspection lot completion and disposition on a work center in Auto counted the pieces a second time | Both routes refuse in Auto |

Checks after the fixes:

- Biome passes on the changed files.
- The ee and jobs typechecks pass. The MES typecheck shows only the `vitest.config.ts` error.
- The OEE tests pass (64), the count step tests pass (5) and the MES tests pass (155).
- Live run: J000002 (untracked, target 1) was loaded on the CNC Mill, and 1 stroke (2 pieces) was sent. The poster posted 1 and sent 1 to `OverTarget`, and the operation went Done.
- Not run: a concurrent assign and count step, and the batch and inspection refusals in the browser. The demo data has no active batch and no inspection operation on a work center in Auto.

## Open

- The QR end scan (`end.$operationId.tsx`) on a work center in Auto refuses
  the whole scan, so it cannot finish an operation that is below its target.
  The operator must use Finish on the operation page. The shop floor does not
  use the QR scan yet, so the fix waits. The proposed fix is to finish the
  operation without a quantity, only when `completeAllOnScan` is on.

- `pnpm-lock.yaml`: the Phase 1 commit that added `apps/pulse-ingest` also
  moved esbuild 0.27.7 → 0.28.2 in other importers. Two Vite copies then sit
  in `node_modules`, and the ERP and MES typechecks report a `vitest.config.ts`
  error. A decision on the lockfile is open.
