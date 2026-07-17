# OEE Work Center Hourly Board (12-hour shifts) + Downtime Recording

**Status:** In progress
**Date:** 2026-07-16
**Depends on:** `.ai/specs/2026-07-09-oee-dashboard.md` (aggregate OEE dashboard)

## Problem

The aggregate OEE dashboard (`/x/production/oee`) reports A/P/Q/OEE per work
center over a date range, but operators and supervisors need the classic
shop-floor TV board: one work center, the current 12-hour shift, broken down
hour by hour — the format the team already runs on their legacy system
(`dashboard.mis/oee/ford.php`): current job orders, Working Time / Planned
Downtime / Unplanned Downtime / Cycle Time, OK/NG/ALL/STD pieces, big %A %P %Q
%OEE numbers, and an hourly table with rows %A, %P, %Q, %OEE, PDT, UPDT,
TARGET, NG, OK.

Carbon also had no way to *record* downtime with a reason — availability could
only be inferred from shift windows and `maintenanceDispatch.oeeImpact`.

## Decisions (confirmed with user 2026-07-16)

| Decision | Choice |
|---|---|
| Where the page lives | Both apps: ERP (primary, drill-down from the OEE dashboard) and MES (TV at the machine) |
| Shift definition | Existing `shift` table (user creates e.g. Day 08:00-20:00 / Night 20:00-08:00 per location); overnight shifts handled in app logic |
| PDT/UPDT source | NEW downtime recording system (reasons typed Planned/Unplanned) + `maintenanceDispatch.oeeImpact`; residual in-shift idle time counts as UPDT |

## Data model (migration `20260716103512_work-center-downtime.sql`)

- `downtimeType` enum: `Planned | Unplanned`
- `downtimeReason`: name + type + active, company-scoped unique name,
  production_* RLS
- `workCenterDowntime`: workCenterId, downtimeReasonId (SET NULL), `type`
  (copied from reason at record time), startTime, endTime (NULL = ongoing),
  notes. Indexed `(companyId, workCenterId, startTime)` + partial open-downtime
  index. Realtime-enabled.
- Perf indexes added: `productionEvent (companyId, workCenterId, startTime)`,
  `productionQuantity (companyId, createdAt)`

## Hourly math (`packages/utils/src/oee.ts`, shared by both apps)

`computeShiftHourlyOee(input)` — pure function, unit-tested. Inputs are
pre-fetched rows; outputs 12 `HourBucket`s + shift totals + live status.

Per hour bucket (clamped to `now` for the current hour; future hours null):

- `PDT` = merged(Planned `workCenterDowntime` + `maintenanceDispatch` with
  `oeeImpact IN ('Planned','Down')`) ∩ bucket
- `runtime` = merged `productionEvent` intervals ∩ bucket (open events clamp to now)
- `UPDT` = elapsed bucket − PDT − runtime (recorded Unplanned rows attribute
  reasons; unrecorded gaps still count)
- `%A` = runtime / (elapsed bucket − PDT)
- `earned` = pieces recorded in the bucket × max(labor, machine) per-piece
  standard — textbook OEE performance. NO setup credit (removed 2026-07-17:
  combined with downtime-subtracted runtime it pushed %P far above 100%);
  setup time counts as runtime with zero earned, i.e. a %P loss
- `%P` = earned / runtime
- `OK` = Production quantity, `NG` = Scrap + Rework (bucketed by
  `productionQuantity.createdAt`); `%Q` = OK / (OK + NG)
- `TARGET` = standard rate of the operation(s) active in the bucket ×
  (bucket − PDT)

Shift totals reuse the same terms across the full shift window. `status` =
`running` (open production event) | `planned-downtime` (open Planned downtime /
active maintenance) | `unplanned-downtime` (open Unplanned downtime) | `idle`.

## Downtime recording

- ERP: `/x/production/downtime-reasons` CRUD (table + ModalDrawer form, same
  pattern as other production config pages); reasons exposed via
  `api/production/downtime-reasons` for combobox use.
- MES: "Downtime" action in the operation Controls sheet — starts an open
  `workCenterDowntime` (reason + notes); becomes "End Downtime" while one is
  open. Starting a production event on the work center auto-closes any open
  downtime.

## Pages

- ERP: `/x/production/oee/work-center/:workCenterId` — TV board + shift/date
  switcher + fullscreen; linked from each row of the OEE dashboard table.
- MES: `/x/oee/:workCenterId` — same board, linked from the operations page.
- Board component `OeeShiftBoard` lives in `packages/react` (props-driven, no
  data fetching) so both apps share one implementation. Live clock via
  `useInterval`; data refresh via `useRealtimeChannel` on `productionEvent`,
  `productionQuantity`, `workCenterDowntime` (debounced) + periodic
  revalidate fallback.
- Shift auto-detection: pick the location shift whose materialized window
  (±1 day padding for overnight) contains "now"; switcher lists all active
  shifts of the work center's location.

## Auto no-output downtime (added 2026-07-16, migration `20260716154237_auto-no-output-downtime.sql`)

When a work center has an open production event but **no output logged within
X × cycle time**, it is automatically flagged as Unplanned downtime with a
configurable default reason (e.g. "No output"). Decisions (confirmed with user):
company-level multiplier + per-work-center override; real `workCenterDowntime`
records via a background job **and** live board detection; downtime of any kind
subtracts from runtime (downtime wins over event, so %A drops).

- **Schema:** `companySettings.autoDowntimeMultiplier NUMERIC` (NULL = feature
  off) + `companySettings.autoDowntimeReasonId` (composite FK →
  `downtimeReason`, `ON DELETE SET NULL`); `workCenter.autoDowntimeMultiplier`
  (NULL = inherit, 0 = disabled per WC; `workCenters` +
  `workCentersWithBlockingStatus` views recreated to expose it);
  `workCenterDowntime.isAuto BOOLEAN` distinguishes auto rows.
- **Math (`@carbon/utils` oee.ts):** `subtractIntervals`, `detectNoOutput`
  (baseline = max(open-event start, last output of the running ops); returns
  the threshold-crossing instant), `ComputeShiftHourlyOeeInput.unplannedDowntimes`
  + `noOutput` config. Runtime per bucket = events − (planned + unplanned
  recorded + virtual no-output window); UPDT stays the residual.
- **Detector:** Inngest cron `detect-no-output-downtime`
  (`packages/jobs/src/inngest/functions/scheduled/detect-no-output-downtime.ts`,
  every minute) — scans companies with both settings set, per work center picks
  effective multiplier (WC override ?? company, ≤0 skip) and msPerPiece =
  max(labor, machine) of the ops with open events; over threshold + no open
  downtime → inserts `{type: Unplanned, isAuto: true, startTime: crossing
  point, downtimeReasonId: default}`. Also sweep-closes open auto rows when
  output arrived or no event is open.
- **Instant close:** the MES insert-quantity functions
  (`insertProductionQuantity`/`insertScrapQuantity`/`insertReworkQuantity`)
  look up `jobOperation.workCenterId` and close **every** open downtime row —
  auto AND manual Planned/Unplanned (user-confirmed 2026-07-17: output proves
  the machine is running, same semantics as starting a production event). The
  board returns to Running without pressing End Downtime.
- **Status priority (both boards):** open downtime record > virtual no-output
  (→ `unplanned-downtime`) > open event (`running`) > `idle`.
- **UI:** ERP Settings → Production card (multiplier + default-reason combobox,
  Unplanned reasons only); WorkCenterForm override Number field; MES
  DowntimeModal shows an "Auto" badge on auto rows.

## Out of scope (future)

- Downtime reason pareto / downtime report pages
- Per-work-center shift calendars (shifts remain location-scoped)
- Editing/back-filling historical downtime intervals in ERP

## Changelog

- 2026-07-16: Initial spec after user confirmation of the three decisions.
- 2026-07-16: Auto no-output downtime — settings columns + isAuto flag,
  detector cron, instant auto-close on output, virtual live detection on the
  boards, settings/work-center UI.
- 2026-07-17: Cycle time shown on the board for visual check — per-job CT
  column in the current-jobs table (max of labor/machine per-piece standard)
  and a board-level "Cycle Time" row in the times card (the exact msPerPiece
  the auto-downtime detector compares against when running; fastest active
  op's standard when idle). New data: `currentJobs[].cycleTimeMs` +
  `cycleTimeMs` from both fetch helpers. Hourly RT (runtime minutes) row
  added above PDT.
- 2026-07-17: %P inflation fix (user-confirmed): setup allowance removed from
  `earned` (%P = pieces × CT / runtime only), and Setup events are exempt
  from no-output detection everywhere (`detectNoOutput`, the cron detector,
  and the boards' msPerPiece/cycleTimeMs) — no output during setup is normal,
  so setup no longer gets auto-flagged as unplanned downtime.
- 2026-07-17: logging output now closes ALL open downtime on the work center
  (manual Planned/Unplanned included, not just auto rows) — user-confirmed;
  `endOpenDowntime`'s `onlyAuto` option removed,
  `endOpenAutoDowntimeForOperation` renamed `endOpenDowntimeForOperation`.
- 2026-07-17: fix — Serial/Batch Log Completed didn't close downtime: those
  paths record output via the `issue` edge function
  (jobOperationSerialComplete/jobOperationBatchComplete), bypassing
  insertProductionQuantity. `endOpenDowntimeForOperation` is now exported and
  called from the Serial/Batch branches of `complete.tsx` and
  `end.$operationId.tsx` after a successful invoke.
- 2026-07-17: refresh countdown — "Refresh in Ns" under the header clock
  (`OeeShiftBoard.refreshIntervalMs` prop, both pages pass 60s); resets when
  new loader data arrives (periodic or realtime refresh).
- 2026-07-17: public TV link — stable unauthenticated share URL per work
  center for TVs. Migration `20260717093245`: `externalLinkDocumentType +=
  'WorkCenter'`. Public page `share+/oee.$id.tsx` in ERP (externalLink token
  → service-role fetch, no menu via the share layout, 60s poll + countdown).
  "Copy Public TV Link" button on both board pages; action
  `getOrCreateWorkCenterShareLink` (ERP production.server.ts + MES
  oee.server.ts copies) reuses the existing externalLink row so the URL never
  changes. ERP path helper `path.to.externalOee`.
