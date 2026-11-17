# OEE dashboard (Pulse Phase 4) — implementation plan

**Spec:** .ai/specs/2026-11-14-oee-dashboard.md
**Research:** .ai/research/oee-dashboard.md
**Closest sibling:** the production dashboard (`x+/production+/_index.tsx` + `api+/production.kpi.$key.ts`) and the MES maintenance display (`display+/$workCenterId.maintenance.tsx`)
**Branch:** `feat/pulse-oee-dashboard` (from `develop`)

## Context

Pulse Phases 1–3 record when each machine runs and how many pieces it makes.
No screen shows OEE yet. The spec (7 questions answered by the user on
2026-11-17) adds a pure OEE calculator in `@carbon/planning`, an ERP page
Production → OEE, and an MES OEE board per work center. One migration keeps
400 days of `machineStateChange` history and adds 2 read indexes.

A planning finding changes 1 spec rule. `util.purge_machine_counts()` deletes
Posted `machineCountPosting` rows after 90 days, so that link cannot tell a
sensor row from an operator's row in an old period. The note
`Pulse sensor <id>` on the `productionQuantity` row is permanent
(`packages/ee/src/oee/counts.server.ts:112`). Task 0 changes the spec to use
the note.

## Progress
- [x] Task 0: Make the branch, copy the plan, correct the spec
- [x] Task 1: Migration: 400-day history and 2 indexes
- [x] Task 2: Move the window helpers to `@carbon/planning`
- [x] Task 3: `standards.ts` (ideal seconds per piece)
- [x] Task 4: `intervals.ts` (run intervals and window math)
- [x] Task 5: `oee.ts` (parts and ratios)
- [x] Task 6: `periods.ts` (current shift and local days)
- [x] Task 7: `load.server.ts` (the shared reader)
- [x] Task 8: ERP API route `api+/production.oee.ts`
- [x] Task 9: ERP page Production → OEE and its nav item
- [x] Task 10: MES OEE board
- [ ] Task 11: Translations
- [ ] Task 12: Docs, rule and AGENTS.md
- [ ] Task 13: Validation gates
- [ ] Task 14: Browser verification

## Dependencies

- Task 1 and Task 2 need Task 0. They are independent of each other.
- Tasks 3, 4 and 6 are independent of each other. They need Task 2.
- Task 5 needs Tasks 3 and 4.
- Task 7 needs Tasks 1, 2, 5 and 6.
- Task 8 needs Task 7. Task 9 needs Task 8.
- Task 10 needs Task 7. Tasks 9 and 10 are independent of each other.
- Task 11 needs Tasks 9 and 10. Task 12 needs Tasks 9 and 10.
- Task 13 needs Tasks 11 and 12. Task 14 needs Task 13.

## Windows notes (this machine)

- Run `pnpm db:migrate` as `bash packages/dev/bin/crbn migrate`, because cmd.exe fails.
- `turbo run typecheck --filter=erp` dies at `generate:mcp`. Run the ERP typecheck in Git Bash: `cd apps/erp && pnpm exec react-router typegen && pnpm exec tsc --noEmit`.
- If a false TS5114 shows, delete `apps/erp/.cache/typecheck.tsbuildinfo` and run again.
- ERP vitest finds no tests on Windows. Run ERP tests by file path (Task 2 Verify).
- No pre-commit hook here. Run `pnpm db:check:datasets` and `pnpm db:check:backups` by hand (Task 13).
- A subagent never runs the ERP typecheck. Only the main agent runs it, once, in Task 13.

---

## Task 0: Make the branch, copy the plan, correct the spec

**Depends on:** none
**Files:**
- Create: `.ai/plans/2026-11-17-oee-dashboard.md` — a copy of this plan
- Modify: `.ai/specs/2026-11-14-oee-dashboard.md` — the Counts table and the Changelog

**Steps:**
1. Run `git switch develop && git pull --ff-only && git switch -c feat/pulse-oee-dashboard`.
2. Copy this plan file to `.ai/plans/2026-11-17-oee-dashboard.md`.
3. In the spec Counts table, replace "rows that no `machineCountPosting` links to" with "rows whose `notes` does not start with `Pulse sensor `".
4. Add this sentence under the Counts table: "The sensor writes the note `Pulse sensor <machineCountPosting.id>` on each row it posts. The note stays after `util.purge_machine_counts()` deletes the posting."
5. Add a Changelog line: "2026-11-17: Plan. A sensor row is found by its note, because postings are purged after 90 days."
6. Do the STE-80 review pass on the spec (`.claude/rules/writing-ste.md`).

**Verify:**
```bash
git branch --show-current
# Expected: feat/pulse-oee-dashboard
grep -c "Pulse sensor " .ai/specs/2026-11-14-oee-dashboard.md
# Expected: 2 or more
```

**Out of scope:** any other spec decision.

---

## Task 1: Migration: 400-day history and 2 indexes

**Depends on:** Task 0
**Files:**
- Create: `packages/database/supabase/migrations/<timestamp>_oee-dashboard-history.sql` (the CLI names it)
- Copy from (precedent): `packages/database/supabase/migrations/20261013191915_oee-tenancy-and-retention.sql`

**Steps:**
1. Run `pnpm db:migrate:new oee-dashboard-history`.
2. Write this SQL into the new file:
```sql
-- OEE needs a year of machine state history (spec
-- .ai/specs/2026-11-14-oee-dashboard.md). Keep the rows of an unmapped or
-- remapped device too: they still hold the work center's run time.
CREATE OR REPLACE FUNCTION util.purge_machine_state_changes()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM "machineStateChange"
  WHERE "changedAt" < NOW() - INTERVAL '400 days';
$$;

REVOKE ALL ON FUNCTION util.purge_machine_state_changes() FROM PUBLIC;

-- The OEE reads Machine events and quantities by work center and time.
CREATE INDEX IF NOT EXISTS "productionEvent_workCenterId_startTime_idx"
  ON "productionEvent" ("workCenterId", "startTime")
  WHERE "type" = 'Machine';

CREATE INDEX IF NOT EXISTS "productionQuantity_companyId_createdAt_idx"
  ON "productionQuantity" ("companyId", "createdAt");
```
3. Run `bash packages/dev/bin/crbn migrate`.
4. Run `pnpm run generate:types`.

If the migration timestamp sorts before the newest file in `packages/database/supabase/migrations/`, STOP and report — do not improvise.

**Verify:**
```bash
psql "$SUPABASE_DB_URL" -Atc "SELECT position('400 days' in prosrc) > 0 FROM pg_proc WHERE proname = 'purge_machine_state_changes'"
# Expected: t
psql "$SUPABASE_DB_URL" -Atc "SELECT count(*) FROM pg_indexes WHERE indexname IN ('productionEvent_workCenterId_startTime_idx','productionQuantity_companyId_createdAt_idx')"
# Expected: 2
git status --short packages/database/src/types.ts
# Expected: no output (no table or column changed)
```

**Out of scope:** the cron schedule `machine-state-change-retention` (it stays), `util.purge_pulse_history()`, `util.purge_unattributed_machine_time()`.

---

## Task 2: Move the window helpers to `@carbon/planning`

**Depends on:** Task 0
**Files:**
- Create: `packages/planning/src/scheduling/work-center-windows.ts` (AGPL header)
- Modify: `packages/planning/package.json` — add the export `"./work-center-windows": "./src/scheduling/work-center-windows.ts"`
- Modify: `apps/erp/app/modules/production/production.service.ts` — delete the moved code, import it
- Modify: `apps/erp/app/modules/production/capacity-buckets.test.ts` — import path
- Modify: `apps/erp/app/routes/x+/priority+/people.tsx` — import path

**Steps:**
1. Move these from `production.service.ts` to `work-center-windows.ts`, unchanged: `type ShiftRow` (export it), `WEEKDAY_FLAGS`, `expandShiftRows` (export it), `getWorkCenterWorkingWindows`, `withoutOutages`, `plantDayBounds` (export it), `workingHoursByDay`, `workingOverlapMs` (export it).
2. In the new file, import `CalendarWindow`, `LadderShiftRow`, `closeHolidays`, `resolveWorkCenterWindows` from `./machine-availability.ts` and `./calendar-utils.ts`. Import `HOUR_MS` from `./date-utils.ts` and `parseDate` from `@internationalized/date`.
3. In `production.service.ts`, import the moved names from `@carbon/planning/work-center-windows`.
4. Re-export `getWorkCenterWorkingWindows`, `withoutOutages` and `workingHoursByDay` from `production.service.ts` (`export { … } from "@carbon/planning/work-center-windows"`). The 2 other call sites keep working with no change.
5. Keep `getForecastNonWorkingIntervals`, `getShiftWorkingWindows` and `getWorkCenterNonWorkingIntervals` in `production.service.ts`.
6. Run `pnpm --filter @carbon/checks license-headers`.

If a moved function needs a name that is not in `packages/planning/src/scheduling/`, STOP and report — do not improvise.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=@carbon/planning
# Expected: 1 successful task, 0 errors
pnpm --filter erp exec vitest run app/modules/production/capacity-buckets.test.ts app/modules/production/forecast.test.ts
# Expected: all tests pass (if "No test files found", run the same command in Git Bash and report the result)
```

**Out of scope:** any change to the logic of the moved functions; the `@carbon/planning` main index (it is server-only).

---

## Task 3: `standards.ts` (ideal seconds per piece)

**Depends on:** Task 2
**Files:**
- Create: `packages/planning/src/oee/standards.ts`, `packages/planning/src/oee/standards.test.ts` (AGPL headers)
- Copy from (precedent): `packages/planning/src/scheduling/*.test.ts` (vitest style)

**Steps:**
1. Export `type MachineUnit` as the `factor` enum union from `@carbon/database` types (`Database["public"]["Enums"]["factor"]`).
2. Export `idealSecondsPerPiece(machineTime: number, machineUnit: MachineUnit): number | null`.
3. Convert by this table. Return null when `machineTime <= 0` or the unit is `Total Hours` or `Total Minutes`.

| Unit | Seconds per piece |
|---|---|
| `Seconds/Piece` | t |
| `Minutes/Piece` | t × 60 |
| `Hours/Piece` | t × 3600 |
| `Minutes/100 Pieces` | t × 60 ÷ 100 |
| `Minutes/1000 Pieces` | t × 60 ÷ 1000 |
| `Hours/100 Pieces` | t × 3600 ÷ 100 |
| `Hours/1000 Pieces` | t × 3600 ÷ 1000 |
| `Pieces/Minute` | 60 ÷ t |
| `Pieces/Hour` | 3600 ÷ t |

4. Export `deviceIdealSecondsPerPiece(expectedCycleSeconds: number | null, piecesPerPulse: number): number | null`. Return null when either value is null or `<= 0`.
5. Write 1 test per unit, plus `machineTime` 0, `Total Hours`, and a null `expectedCycleSeconds`.

**Verify:**
```bash
pnpm --filter @carbon/planning exec vitest run src/oee/standards.test.ts
# Expected: all tests pass
```

**Out of scope:** labor and setup standards.

---

## Task 4: `intervals.ts` (run intervals and window math)

**Depends on:** Task 2
**Files:**
- Create: `packages/planning/src/oee/intervals.ts`, `packages/planning/src/oee/intervals.test.ts` (AGPL headers)

**Steps:**
1. Export `type Interval = { start: number; end: number }` (epoch ms, half-open).
2. Export `unionIntervals(list: Interval[]): Interval[]`: sorted, merged, empty ones dropped.
3. Export `intervalLength(list: Interval[]): number`: the sum after `unionIntervals`.
4. Export `intersectWindows(a: Interval[], b: Interval[]): Interval[]`.
5. Export `subtractWindows(a: Interval[], b: Interval[]): Interval[]`. Build it on `subtractIntervals` from `../scheduling/calendar-utils.ts`.
6. Export `clipIntervals(list: Interval[], period: Interval): Interval[]`.
7. Export `runIntervalsFromStateChanges(changes: { changedAt: number; state: string }[], until: number): Interval[]`. Sort by `changedAt`. A `Running` change runs until the next change, or until `until`.
8. Write tests: overlap merge, a run that crosses a period end, a Running change as the last change, 2 Running changes in a row (one run), and an empty list.

**Verify:**
```bash
pnpm --filter @carbon/planning exec vitest run src/oee/intervals.test.ts
# Expected: all tests pass
```

**Out of scope:** the debounce of `minimumStateSeconds` (the stored changes are already the provider's).

---

## Task 5: `oee.ts` (parts and ratios)

**Depends on:** Tasks 3, 4
**Files:**
- Create: `packages/planning/src/oee/oee.ts`, `packages/planning/src/oee/oee.test.ts`, `packages/planning/src/oee/index.ts` (AGPL headers)
- Modify: `packages/planning/package.json` — add the export `"./oee": "./src/oee/index.ts"`

**Steps:**
1. Export this input type:
```ts
export type OeeWorkCenterInput = {
  period: Interval;
  plannedWindows: Interval[]; // working windows − Planned stops
  runIntervals: Interval[];
  owners: { start: number; end: number; jobOperationId: string }[]; // Machine events
  idealByOperation: Map<string, number | null>; // seconds per piece
  deviceIdealSeconds: number | null;
  counts: {
    at: number;
    jobOperationId: string | null; // null: take the owner at `at`
    total: number;
    bad: number;
  }[];
};
```
2. Export `type OeeParts = { plannedMs; runMs; runOutsideMs; runWithStandardMs; idealMs; totalPieces; badPieces }`, all numbers.
3. Export `computeOeeParts(input: OeeWorkCenterInput): OeeParts`. Clip every interval to `period` first.
4. Compute `runOutsideMs` = length of (run − planned windows). Compute `plannedMs` = length of planned windows + `runOutsideMs`. Compute `runMs` = length of run.
5. Find the ideal of a moment: the owner's `idealByOperation` value, else `deviceIdealSeconds`, else null.
6. Compute `runWithStandardMs`: the run time whose ideal is not null.
7. Compute `idealMs`: Σ ideal × `total` × 1000 for each count with an ideal. A count with `jobOperationId` uses that operation's ideal, else `deviceIdealSeconds`.
8. Compute `totalPieces` = Σ `total` and `badPieces` = Σ `bad`, counting only rows with `at` inside the period.
9. Export `addOeeParts(a: OeeParts, b: OeeParts): OeeParts` (field by field) and `EMPTY_OEE_PARTS`.
10. Export `oeeRatios(parts)`: `availability` = runMs ÷ plannedMs, `performance` = idealMs ÷ runWithStandardMs, `quality` = (total − min(bad, total)) ÷ total, `standardCoverage` = runWithStandardMs ÷ runMs, `oee` = the product of the first 3. A ratio with a 0 denominator is null. `oee` is null if one factor is null.
11. `index.ts` re-exports `intervals.ts`, `standards.ts`, `oee.ts` and `periods.ts` (Task 6). It imports nothing from `@carbon/ee` and nothing from a database client.
12. Write these tests:
    1. The spec example: 8 h planned, 6 h run, 2000 pieces at 9 s, 40 bad. Expect 0.75, 0.8333, 0.98, 0.6125 (to 4 places).
    2. A run that crosses a shift end: `runOutsideMs` holds the part after it.
    3. A run inside a Planned stop: it adds to `runOutsideMs`.
    4. A run fully outside the shifts: `availability` = 1.
    5. A work center with no standard: `performance` null, `standardCoverage` 0.
    6. A roll-up of 2 work centers with `addOeeParts` that differs from the average of their 2 OEE values.
    7. A pulse count with `jobOperationId` null takes the owner's ideal.

**Verify:**
```bash
pnpm --filter @carbon/planning test
# Expected: all test files pass, including src/oee/oee.test.ts
```

**Out of scope:** reading the database.

---

## Task 6: `periods.ts` (current shift and local days)

**Depends on:** Task 2
**Files:**
- Create: `packages/planning/src/oee/periods.ts`, `packages/planning/src/oee/periods.test.ts` (AGPL headers)

**Steps:**
1. Export `currentShiftPeriod(windows: Interval[], now: number): Interval | null`. Merge touching windows first. Return the window that holds `now`, cut at `now`. Else return the last window that ended before `now`. Else return null.
2. Export `localDayPeriod(now: number, timeZone: string): Interval`: from local midnight to `now`. Use `@internationalized/date` (`fromAbsolute`, `startOfDay`), never JS `Date`.
3. Export `dayPeriods(fromDate: string, toDate: string, timeZone: string): { day: string; period: Interval }[]`: one period per local day, both dates inclusive. Use `parseDate(day).toDate(timeZone)` as in `plantDayBounds`.
4. Write tests: now inside a shift, now between 2 shifts, now before the first shift, a DST day in `America/New_York` (23 h), and `Asia/Bangkok`.

**Verify:**
```bash
pnpm --filter @carbon/planning exec vitest run src/oee/periods.test.ts
# Expected: all tests pass
```

**Out of scope:** shift names.

---

## Task 7: `load.server.ts` (the shared reader)

**Depends on:** Tasks 1, 2, 5, 6
**Files:**
- Create: `packages/planning/src/oee/load.server.ts` (AGPL header)
- Modify: `packages/planning/package.json` — add the export `"./oee/load.server": "./src/oee/load.server.ts"`
- Copy from (precedent): the window build in `apps/erp/app/routes/x+/priority+/people.tsx:440-480`; `readBlocks` in `packages/jobs/src/inngest/functions/integrations/oee-sync-device.ts:131`

**Steps:**
1. Export this signature:
```ts
export async function loadOeeWorkCenters(
  client: SupabaseClient<Database>,
  args: { companyId: string; workCenterIds: string[]; from: number; to: number; now: number; timeZone: string }
): Promise<{ data: OeeLoadedWorkCenter[]; error: PostgrestError | null }>;

export type OeeLoadedWorkCenter = {
  workCenterId: string;
  source: "Sensor" | "Operator";
  workingWindows: Interval[]; // shifts with holidays closed
  input: Omit<OeeWorkCenterInput, "period">; // all rows inside [from, to)
};
```
2. Read with `fetchAllRecords` / `fetchAllByIds` (`@carbon/database`), and scope every read by `companyId`. Make 1 read per table, never 1 per work center.
3. Read `workCenter` (`id, alwaysOn, locationId`), `workCenterShift`, the location's `shift` rows and the linked shifts (`getShiftsWithTimes` fields), and `holiday` dates. Build the windows with `getWorkCenterWorkingWindows` (Task 2).
4. Read the Planned stops: `maintenanceDispatch` with `oeeImpact = 'Planned'`, `actualStartTime` not null, on `workCenterId`. The end is `completedAt`, else `actualEndTime`, else `now` while `status = 'In Progress'`, else `updatedAt`, else `createdAt`. `plannedWindows` = working windows − Planned stops.
5. Read `machineStateChange` (`workCenterId, changedAt, state`) in `[from, to)`. Also read the last row before `from` per work center, in 1 query with `changedAt < from` ordered by `workCenterId, changedAt desc`, limited by a 400-day lower bound.
6. Set `source = "Sensor"` when the work center has a `workCenterDevice` row or a state change in the range. For a Sensor work center, `runIntervals` = `runIntervalsFromStateChanges(changes, min(to, now))`.
7. Read Machine `productionEvent` (`workCenterId, jobOperationId, startTime, endTime`) that overlap `[from, to)`. An open event ends at `now`. These rows are `owners`. For an Operator work center, `runIntervals` = their union.
8. Read the `jobOperation` rows of the owners (`id, machineTime, machineUnit`). Build `idealByOperation` with `idealSecondsPerPiece`.
9. Find the Pulse device: `workCenterDevice.integration = 'pulse'`, then `pulseDevice` where `deviceKey = externalDeviceId`. Set `deviceIdealSeconds` with `deviceIdealSecondsPerPiece`.
10. For a Pulse work center, read `pulseCount` (`periodEnd, pulses, scrapPulses`) by `pulseDeviceId` in `[from, to)`. Each row is a count: `at = periodEnd`, `jobOperationId` null, `total = pulses × piecesPerPulse`, `bad = scrapPulses × piecesPerPulse`.
11. For a Pulse work center, read the Scrap and Rework `productionQuantity` rows on its operations in `[from, to)` whose `notes` does not start with `Pulse sensor `. Each row is a count with `total` 0 and `bad = quantity`.
12. For any other work center, read every `productionQuantity` row on its operations in `[from, to)`: `total = quantity`, `bad = quantity` for Scrap and Rework, else 0.
13. Find the operations of a work center for steps 11–12 by `jobOperation.workCenterId`, then `productionQuantity.jobOperationId` with `fetchAllByIds`, filtered by `createdAt`.
14. Convert every timestamp with `toInstantMs` (`../scheduling/date-utils.ts`), never `new Date`.
15. Return `{ data: [], error }` on the first read error. Never throw.

If `pulseCount` has no `pulseDeviceId` column, STOP and report — do not improvise.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=@carbon/planning
# Expected: 1 successful task, 0 errors
pnpm --filter @carbon/checks test
# Expected: the same pass/fail list as on develop (license-files and no-raw-rounding fail on a clean tree too); no new failure names load.server.ts
```

**Out of scope:** caching; a snapshot table.

---

## Task 8: ERP API route `api+/production.oee.ts`

**Depends on:** Task 7
**Files:**
- Create: `apps/erp/app/routes/api+/production.oee.ts` (AGPL header)
- Modify: `apps/erp/app/utils/path.ts` — `api.productionOee: \`${api}/production/oee\`` next to `productionKpi`
- Copy from (precedent): `apps/erp/app/routes/api+/production.kpi.$key.ts`

**Steps:**
1. Call `requirePermissions(request, { view: "production" })`.
2. Read `locationId`, `start` and `end` (`YYYY-MM-DD`) from the query string.
3. If a value is missing, `end < start`, or the range is longer than 92 days, return `{ workCenters: [], days: [], totals: null }`.
4. Read the location's `timezone`, scoped by `companyId`. Fall back to `getCompanyTimeZone` (`@carbon/database`).
5. Read the active work centers of the location (`id, name`).
6. Call `loadOeeWorkCenters` with `from` = the start of `start`, `to` = the end of `end`, in the location's timezone. Cut `to` at now.
7. For each work center and each `dayPeriods` day, call `computeOeeParts`. Add the parts with `addOeeParts`.
8. Return `workCenters` (`id, name, source, parts, ratios`), `days` (`day, parts, ratios`, summed over the work centers) and `totals` (`parts, ratios`).

**Verify:**
```bash
cd apps/erp && pnpm exec react-router typegen && pnpm exec tsc --noEmit
# Expected: no error in api+/production.oee.ts (Task 13 runs the full ERP typecheck)
```

**Out of scope:** CSV export.

---

## Task 9: ERP page Production → OEE and its nav item

**Depends on:** Task 8
**Files:**
- Create: `apps/erp/app/routes/x+/production+/oee.tsx` (AGPL header)
- Modify: `apps/erp/app/utils/path.ts` — `productionOee: \`${x}/production/oee\`` next to `unattributedMachineTimes`
- Modify: `apps/erp/app/modules/production/ui/useProductionSubmodules.tsx` — an "OEE" item inside the `hasOeeProvider` block, before "Unattributed Time", icon `LuGauge`
- Copy from (precedent): `apps/erp/app/routes/x+/production+/_index.tsx` (date range, `useLoaderQuery`, `ChartContainer`); `apps/erp/app/components/MetricCard.tsx`; the work center table of `apps/erp/app/routes/x+/resources+/_index.tsx`

**Steps:**
1. In the loader, call `requirePermissions(request, { view: "production" })`.
2. In the loader, read the locations with `getLocationsList` (`modules/resources/resources.service.ts`).
3. In the loader, read the default location with `getUserDefaults` (`modules/users/users.service.ts`), else the first location.
4. Keep `locationId`, `start` and `end` in the URL search params. The default range is the last 7 days.
5. Fetch the data with `useLoaderQuery(path.to.api.productionOee + query)`, as `_index.tsx` does with `productionKpi`.
6. Show 4 `MetricCard`s: OEE, Availability, Performance, Quality, from `totals.ratios`.
7. Show a line chart of `days[].ratios.oee` with `ChartContainer`, copied from `_index.tsx`.
8. Show a table with the columns Work Center, Source, Planned time, Run time, Run outside shifts, Availability, Performance, Standard coverage, Quality, OEE.
9. Format a ratio as a percent with 1 decimal. Show "—" for null. Format times with `formatDurationMilliseconds` (`@carbon/utils`).
10. Show an empty state when `totals.parts.plannedMs` is 0.
11. Use Lingui (`useLingui().t`, `<Trans>`) for every string.
12. Load the `carbon-design` skill before you write the page.

**Verify:**
```bash
cd apps/erp && pnpm exec react-router typegen && pnpm exec tsc --noEmit
# Expected: no error in oee.tsx or useProductionSubmodules.tsx
```

**Out of scope:** a page guard on the integration (the nav rule matches Unattributed Time); drill-down per operation.

---

## Task 10: MES OEE board

**Depends on:** Task 7
**Files:**
- Modify: `apps/mes/package.json` — add `"@carbon/planning": "workspace:*"`, then run `pnpm install --frozen-lockfile=false --ignore-scripts`
- Modify: `apps/mes/app/services/display.service.ts` — `getOeeDisplayData`
- Create: `apps/mes/app/routes/display+/$workCenterId.oee.tsx` (AGPL header)
- Modify: `apps/mes/app/utils/path.ts` — `oeeDisplay: (workCenterId) => generatePath(\`${display}/${workCenterId}/oee\`)`
- Modify: `apps/mes/app/routes/display+/_index.tsx` — an OEE `DisplayLink` (icon `LuGauge`) after the maintenance link
- Copy from (precedent): `apps/mes/app/routes/display+/$workCenterId.maintenance.tsx`, `apps/mes/app/components/Display/Scoreboard.tsx`

**Steps:**
1. Add `getOeeDisplayData(client, { workCenterId, companyId, timeZone, now })` to `display.service.ts`.
2. In it, call `loadOeeWorkCenters` for today's local day, with 1 day of margin before it.
3. In it, find the period with `currentShiftPeriod(workingWindows, now)`. If the work center is `alwaysOn` or the result is null, use `localDayPeriod(now, timeZone)`.
4. In it, return `period`, `parts` and `ratios` from `computeOeeParts`.
5. Copy the loader of `$workCenterId.maintenance.tsx`: `requirePermissions(request, {})`, `getCarbonServiceRole()`, `getDisplayWorkCenter` as the tenancy gate, and the location `timezone`.
6. Fall back to the company timezone (`getCompanyTimeZone`) when the location has none.
7. Render `DisplayFrame` with `ScoreboardRow`s: OEE, Availability, Performance, Quality, Run time, Good pieces, Scrap.
8. Show the period start and end in the location's timezone.
9. Use `countTone` thresholds: OEE ≥ 0.85 `good`, ≥ 0.6 `warn`, else `danger`.
10. Use Lingui for every string.

If `pnpm install` changes any line of `pnpm-lock.yaml` other than the `apps/mes` importer block, STOP and report — do not improvise.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=mes
# Expected: 1 successful task, 0 errors
git diff --stat pnpm-lock.yaml
# Expected: a few lines in the apps/mes importer only
```

**Out of scope:** the work display (`$workCenterId.work.tsx`); a shift picker.

---

## Task 11: Translations

**Depends on:** Tasks 9, 10
**Files:**
- Modify: `packages/locale/locales/*/*.po`

**Steps:**
1. Run `pnpm lingui:extract`.
2. Run the `/translate` skill.

**Verify:**
```bash
pnpm lingui:extract
# Expected: 0 missing translations for every locale
```

**Out of scope:** strings outside this feature.

---

## Task 12: Docs, rule and AGENTS.md

**Depends on:** Tasks 9, 10
**Files:**
- Modify: `.claude/rules/oee-provider.md` — a section "OEE screens" (sources, formulas, files) and the new retention
- Modify: `packages/planning/AGENTS.md` — the `oee` and `work-center-windows` subpaths
- Modify: `apps/erp/app/modules/production/AGENTS.md` — the OEE page
- Modify: `.ai/specs/2026-11-14-pulse-machine-monitoring.md` — the Phase 4 line points to the new spec as built
- Modify: `.ai/plans/2026-11-14-pulse-machine-monitoring.md` — tick the 3 Phase 4 items
- Modify: `.ai/specs/2026-11-14-oee-dashboard.md` — Status `implemented`, Changelog line
- Modify: the OEE page in `docs/content/` (use the `carbon-docs` skill; find it with `grep -ril "unattributed time" docs/content`)

**Steps:**
1. Write each claim from the committed code, not from this plan.
2. Do the STE-80 review pass on each `.ai/` file you change.

**Verify:**
```bash
grep -n "OEE screens" .claude/rules/oee-provider.md
# Expected: 1 match
pnpm --filter docs build
# Expected: the build ends with no error
```

**Out of scope:** moving the spec to `implemented/` (ask the user first).

---

## Task 13: Validation gates

**Depends on:** Tasks 11, 12
**Files:** none

**Steps:**
1. Run `pnpm --filter @carbon/planning test`.
2. Run `pnpm exec turbo run typecheck --filter=@carbon/planning --filter=mes --concurrency=1`.
3. Run the ERP typecheck in Git Bash: `cd apps/erp && pnpm exec react-router typegen && pnpm exec tsc --noEmit`.
4. Run `pnpm run lint`.
5. Run `pnpm --filter @carbon/checks test`.
6. Run `pnpm db:check:datasets && pnpm db:check:backups`.
7. Commit with the `/check-and-commit` skill.

If `db:check:backups` fails on a `machineStateChange.workCenterDeviceId` that no longer exists, STOP and report — do not improvise.

**Verify:**
```bash
pnpm --filter @carbon/planning test && pnpm run lint
# Expected: all tests pass; Biome reports 0 errors
```

**Out of scope:** the failures that exist on a clean `develop` (license-files, `no-raw-rounding` in `AssemblyBomTree.tsx`).

---

## Task 14: Browser verification

**Depends on:** Task 13
**Files:** none

**Steps:**
1. Start the stack (`crbn up`) and the simulator (`pnpm --filter pulse-ingest simulate`, http://127.0.0.1:4810).
2. Give the `sim-cnc` work center a shift. Set the operation `machineTime` to 9 `Seconds/Piece`.
3. Run `sim-cnc` with Log scrap presses. Note the raw sums of `pulses` and `scrapPulses` in `pulseCount` for the period.
4. Run the `/test` skill on Production → OEE and on the MES OEE board of `sim-cnc`.
5. Check that the OEE pieces agree with `pulses × piecesPerPulse` within 1 %.
6. Check that the ERP card values match the MES board for the same shift.
7. Unmap and map `sim-cnc` again. Check that the earlier run time still shows.
8. Deactivate the Pulse integration. Check that the nav item "OEE" is hidden.

**Verify:**
```bash
ls .ai/playbooks/ | grep -i oee
# Expected: the playbook that /test saved
```

**Out of scope:** real hardware (the pilot acceptance stays open in the parent spec).

## Run notes

- 2026-11-17, Task 1: `pnpm db:migrate:new` gave `20261117055352`, which sorts before `20261117091847_printer-api-key-vault.sql` from upstream. The escape hatch fired. The user chose to rename the empty, unapplied file to `20261117092413_oee-dashboard-history.sql`.
- 2026-11-17, Task 1: `check:workflow-catalog` fails in cmd.exe at `generate:mcp`. Run `scripts/generate-mcp.ts` and `scripts/check-workflow-catalog.ts` with `pnpm exec tsx` in Git Bash instead.
- 2026-11-17, Task 2: ERP vitest takes a test path only through a local config that turns the backslashes in `include` into slashes: `apps/erp/vitest.win.local.config.ts` (never committed). With it, `capacity-buckets.test.ts` and `forecast.test.ts` pass (23 tests).
- 2026-11-17, Task 2: `src/mrp/plan-company.test.ts` (golden snapshot) fails in `@carbon/planning` on `develop` too. It is not caused by this work.
- 2026-11-17, Task 7: A scratch vitest run of `loadOeeWorkCenters` against `wt_carbon` (`sim-cnc`, `sim-tig`) read every table with no error: source Sensor, run intervals, owners, counts and the device ideal (3 s). tsx cannot load `@carbon/database` here, so the scratch ran through vitest, then was deleted.
- 2026-11-17, Task 7: Deviations from the task text: the reader also returns `alwaysOn` (the MES needs it), reads the standards of the operations that hold counts, and uses the device's `currentState` when no change falls in the 7-day lookback (no query per work center).
- 2026-11-17, Task 7: `@carbon/checks` `run.test.ts` fails here because Windows paths use backslashes, so every baselined line reads as new. No listed line is in `packages/planning/src/oee/` or `work-center-windows.ts`.
- 2026-11-17, Tasks 8–9: one ERP typecheck (exit 0) covers both tasks, so the ~10 GB check ran once.
- 2026-11-17, Task 10: `pnpm install` also swapped the `esbuild` peer (0.27.7 ↔ 0.28.2) of `vite` and `@lingui/vite-plugin` between the ERP and MES importers. The escape hatch fired. The user chose to keep only the 3 `@carbon/planning` lines in the `apps/mes` importer; `pnpm install --frozen-lockfile --ignore-scripts` accepts the file. MES lists `@carbon/*` under `devDependencies`, so the new entry goes there.
- 2026-11-17, Task 10: `getOeeDisplayData` lives in `apps/mes/app/services/display.server.ts`, not `display.service.ts`: a component (`ActiveWorkPanel`) imports `display.service.ts`, and a MES service file never imports a `.server` module (`.ai/lessons.md`).
