# OEE Dashboard (Production → OEE)

- **Status:** in-progress
- **Author:** Carbon agent session (requested by Khompetch)
- **Date:** 2026-07-09

## TLDR

A new `/x/production/oee` page showing Overall Equipment Effectiveness
(OEE = Availability × Performance × Quality) grouped by work center or by
process (operation type), over a selectable date range, with realtime refresh
while the range includes the present. Computed entirely from existing tables —
no migration.

## Problem Statement

Carbon captures everything OEE needs (production events, quantities with
scrap/rework, standard times, maintenance downtime with an `oeeImpact` enum,
location shifts) but exposes only raw work-center utilization. Factory
management wants the standard OEE breakdown per operation to find losses.

## Proposed Solution

A dashboard page + a KPI resource route (`/api/production/oee`) that
aggregates in TypeScript, cloning the established
`api+/production.kpi.$key.ts` pattern.

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Grouping | Toggle between Work Center and Process | Both are FKs on `jobOperation`; OEE is classically per equipment, user also wants per operation type |
| Planned time (Availability denominator) | Active `shift` windows of the work center's **location** (day-of-week flags, location timezone), minus maintenance downtime (`oeeImpact IN ('Down','Planned')`) | No WC↔shift link exists; avoids a migration. Limitation: all WCs in a location share the same planned time |
| Performance standard | `makeDurations` (existing helper) over the operation's setup/labor/machine times, quantity = pieces recorded in range; earned = setup (only if a Setup event occurred in range) + max(labor, machine) | Matches the scheduling convention `duration = setup + max(labor, machine)` |
| Quality | `productionQuantity`: Production / (Production + Scrap + Rework) in range | Direct source of truth; scrap pareto by `scrapReason` |
| Process-view availability | Planned time = union of planned time of the distinct WCs where the process ran in range | Documented approximation — a process has no planned calendar of its own |
| Placement | Dedicated page `/x/production/oee` + nav entry | Full A/P/Q breakdown, per-group table, scrap pareto need room |
| Realtime | Subscribe `productionEvent` + `productionQuantity` postgres changes (company-scoped), debounce ~10 s, refetch; only when the range includes now | Same `useRealtimeChannel` pattern as the production dashboard's WorkCenterCards |
| Aggregation location | Inline in the resource route (like `production.kpi.$key.ts`), not new service fns | Follows the established KPI-route precedent; one file owns the math |

## Data Model Changes

None.

## API / Service Changes

New resource route `apps/erp/app/routes/api+/production.oee.ts`:
`GET /api/production/oee?start&end&groupBy=workCenter|process&locationId?`
→ `{ groups: [{ id, name, availability, performance, quality, oee,
runtimeMs, plannedMs, downtimeMs, good, scrap, rework }], totals, previousTotals,
scrapPareto: [{ reason, quantity }] }`. Gated by
`requirePermissions({ view: "production" })`; all queries scoped by `companyId`.

## UI Changes

- New route `apps/erp/app/routes/x+/production+/oee.tsx` — KPI tiles
  (OEE/A/P/Q + trend badge vs previous period), group bar chart, per-group
  table, scrap pareto; `DateSelect`, group-by toggle, location filter,
  realtime refresh + Live indicator.
- Components in `apps/erp/app/modules/production/ui/Oee/`.
- Nav entry in `useProductionSubmodules`.
- `path.to.productionOee` + `path.to.api.productionOee`.

## Acceptance Criteria

- [ ] `/x/production/oee` renders for a user with `production_view`
- [ ] A, P, Q, OEE per work center match hand-computed values for a known dataset
- [ ] Toggle switches grouping to process and back without refetch errors
- [ ] Date range + location filter change the aggregates
- [ ] With the range including today, an MES start/complete updates the page within ~15 s without refresh
- [ ] Empty states render when no events exist in range
- [ ] All user-facing strings are Lingui-wrapped

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Location-level shifts overstate planned time for underused WCs | Medium | Documented; v2 could add per-WC calendars |
| Factor-unit normalization errors skew Performance | Medium | Reuse battle-tested `makeDurations`; adversarial review of the math |
| Open events (endTime null) inflate runtime | Low | Clamp to now and to the range window (same as utilization KPI) |
| Timezone/DST edge cases in shift windows | Low | Weekday resolved via `Intl` with the location timezone; DST drift accepted for v1 |

## Open Questions

Resolved 2026-07-09 with the requester: grouping toggle (both), planned time
from location shifts (no migration), dedicated page, realtime included.

## Changelog

- 2026-07-09 — drafted; decisions resolved via interactive Q&A.
- 2026-07-16 — extended by `.ai/specs/2026-07-16-oee-work-center-hourly.md`:
  per-work-center hourly TV board (12-hour shifts) + downtime recording
  (`downtimeReason`/`workCenterDowntime`).
