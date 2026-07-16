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
- `earned` = setup standard (if a Setup event ran) + max(labor, machine)
  standard for pieces recorded in the bucket (`makeDurations` convention)
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

## Out of scope (future)

- Downtime reason pareto / downtime report pages
- Per-work-center shift calendars (shifts remain location-scoped)
- Editing/back-filling historical downtime intervals in ERP

## Changelog

- 2026-07-16: Initial spec after user confirmation of the three decisions.
