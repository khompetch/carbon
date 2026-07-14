# Work Center Required Ability Gate

- **Status:** in-progress
- **Author:** Carbon agent session (requested by Khompetch)
- **Date:** 2026-07-14

## TLDR

Activate the dormant `workCenter.requiredAbilityId` column as a hard gate:
an operator who has not completed training for the work center's required
ability cannot start job operations there in MES. The ERP work-center form
gains the (previously commented-out) Required Ability picker; MES blocks
both start paths and shows a pre-emptive warning banner with a disabled
Start button.

## Problem Statement

`workCenter.requiredAbilityId` (FK → `ability`) has existed in the schema
since `20240819115702_work-centers.sql` but was never wired up: the form
field and validator entry were commented out and no runtime code read the
column. Factories need to prevent untrained operators from clocking into
work centers that require a certified skill.

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| "Has ability" criterion | `employeeAbility` row with `active = true` AND `trainingCompleted = true` | User choice: operators still in training remain blocked (compliance-strict) |
| Enforcement style | Hard block, no supervisor override | User requirement: "ไม่ให้เข้าทำงาน" |
| Enforcement mechanism | Bespoke guard (like the maintenance block in the same loader), not `@carbon/ee/storage-rules` | The rules engine's `TargetType` union and condition system are purpose-built for storage conditions; an ability check is a simple existence query |
| Guarded entry points | Both MES start paths: POST `x+/event.tsx` ("Start" branch, work center resolved server-side from `jobOperationId`) and GET `x+/start.$operationId.tsx` (QR-code / ERP deep link) | Either path alone can start a production event |
| Pre-emptive UI | Amber banner + disabled Start (Play) button on the MES operation page | User choice: operator learns before pressing, not via a rejection toast |
| Stop/End behavior | Never blocked — only starting is gated | An operator with a running event must always be able to clock out |
| FK semantics | Changed `ON DELETE CASCADE` → `ON DELETE SET NULL` | Deleting an ability definition must not delete work centers |
| Fail behavior on query error | Fail-open (no block) | Matches the maintenance-block pattern; a transient DB error must not halt production |

## Data Model Changes

Migration `20260714102347_work-center-required-ability.sql` — re-creates
`workCenter_requiredAbilityId_fkey` with `ON DELETE SET NULL`. No new
columns; no type regeneration needed (constraint-only change).

## API / Service Changes

- `apps/mes/app/services/operations.service.ts` — new
  `getMissingRequiredAbility(client, { workCenterId, employeeId, companyId })`
  → `{ abilityId, abilityName } | null` (null = allowed). `employeeId` is the
  Supabase `userId` (`employee.id === user.id` by convention).
- `apps/mes/app/routes/x+/start.$operationId.tsx` — guard after the
  maintenance block; redirect to the operation page with a flash error.
- `apps/mes/app/routes/x+/event.tsx` — guard in the `"Start"` branch;
  returns flash error data.

## UI Changes

- ERP `WorkCenterForm.tsx` — `<Ability name="requiredAbilityId" />` enabled
  (optional, clearable) with helper text; `workCenterValidator` field
  uncommented. Persistence flows through the existing spread-based
  `upsertWorkCenter`.
- MES `operation.$operationId.tsx` loader — computes `missingAbility`
  (ability name or null) and passes it to `JobOperation`.
- MES `JobOperation.tsx` — amber `LuTriangleAlert` banner above the
  Start controls; `StartStopButton` gains `startDisabled` (disables the
  Play button only — Pause/End stays enabled).

## Acceptance Criteria

- Work center with no required ability → behavior unchanged everywhere.
- Operator without the ability (or `trainingCompleted = false`): sees the
  banner, Start button disabled, QR deep link `/x/start/:id` redirects back
  with "Cannot start operation" flash, POST to `/x/event` with
  `action=Start` is rejected with the same message.
- Operator with `active + trainingCompleted` `employeeAbility` → can start.
- Operator with a running production event can always End it.
- Deleting an ability leaves work centers intact with
  `requiredAbilityId = NULL`.

## Out of Scope

- ERP scheduling-side prevention (scheduling has no per-employee awareness).
- Supervisor override / acknowledge flow.
- The `training`/`trainingCompletion` module (separate system from
  `ability`/`employeeAbility`).

## Changelog

- 2026-07-14: Initial implementation.
