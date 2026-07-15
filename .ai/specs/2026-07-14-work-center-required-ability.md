# Work Center Required Ability + Trainings Gate

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

## Extension: Multiple Required Trainings (2026-07-15)

A work center can additionally require **multiple trainings** from the
Resources → Training module (quiz + recertification). Operators must hold a
valid `trainingCompletion` for **every** linked Active training — for
`Once` trainings any completion counts (`period IS NULL`); for
`Quarterly`/`Annual` the completion's `period` must equal
`get_current_training_period(frequency)` (a lapsed period blocks until the
operator re-passes the quiz). Completion may come through any
`trainingAssignment` of that training; an operator never assigned the
training is blocked until an admin assigns it and they pass.

| Decision | Choice | Rationale |
|---|---|---|
| Data model | `workCenterTraining` join table (composite PK, CASCADE), mirroring `workCenterProcess` | Established many-to-many pattern in the same module |
| Training reference | Specific `training.id` | Same precedent as `trainingAssignment.trainingId`; versioning is dormant (all rows v0) |
| Validity check | SQL RPC `get_missing_required_trainings(workCenterId, employeeId, companyId)` SECURITY DEFINER | Period logic stays in SQL beside `get_current_training_period`; MES calls it directly |
| Not via `get_training_assignment_status` | Direct `trainingCompletion → trainingAssignment` join | The status RPC only sees employees inside assigned groups — can't distinguish "not assigned" from "completed" |
| Draft/Archived trainings | Ignored by the gate | Only `status = 'Active'` rows are requirements |
| UI | Multi-select `Trainings` picker in WorkCenterForm; MES banner lists every missing item | Same UX as the ability gate, additive |

Migration: `20260714171532_work-center-required-trainings.sql`. New pieces:
`apps/erp/app/components/Form/Trainings.tsx`,
`api+/resources.trainings.list.ts`, `requiredTrainingIds` in
`workCenterValidator`/`upsertWorkCenter`,
`getMissingWorkCenterRequirements` in MES `operations.service.ts` (wraps the
ability check + the RPC), banner + Start-disable in `JobOperation.tsx`.

Note: `workCenterTraining` and the RPC are not yet in the generated DB types
— two scoped `as SupabaseClient<any>` casts (marked with comments) should be
removed after `pnpm db:migrate` regenerates types.

## Changelog

- 2026-07-14: Initial implementation (single required ability).
- 2026-07-15: Multiple required trainings per work center (Training module gate).
- 2026-07-15: Rebuilt the Abilities management UI (upstream had removed all
  ability routes, leaving `path.to.newAbility` links 404ing): list at
  `/x/resources/abilities`, create/delete, detail page at
  `/x/resources/ability/:id` with employee assignment
  (status → `trainingCompleted`/`trainingDays`), nav entry under
  Resources → People.
