# Pulse machine monitoring + OEE screens

Approved 2026-11-14. Sibling: the Sense OEE provider (`packages/ee/src/sense`,
`.claude/rules/oee-provider.md`). Spec to write: `.ai/specs/2026-11-14-pulse-machine-monitoring.md`.

## Goal

The user has no Sense devices. Build an in-house machine monitor that works the
same way, then show OEE from its data.

- Signal: one pulse per machine cycle from a proximity or photo sensor. Pieces
  per pulse is configurable per device.
- Path: ESP32 → MQTT (on-site gateway → Mosquitto in the Dokploy stack) →
  `apps/pulse-ingest` → Postgres → the existing OEE engine through a new
  provider, `pulse`.
- The engine, the sync jobs, the Devices tab, Unattributed Time and the MES
  state badge are reused unchanged. The deployment moves to
  `CARBON_EDITION=enterprise` (the user holds a commercial license).
- New on top of the engine: sensor counts post `productionQuantity`
  automatically on the loaded operation.

## Decisions

- Ingest is its own compose service, not part of the ERP: one long-lived MQTT
  client, no duplicate subscribers, not gated by ERP deploys.
- Ingest imports no `@carbon/ee` code and stays AGPL. Files under
  `packages/ee` or named `*.ee.*` carry the commercial header.
- State is inferred: Running when pulses arrive, Idle when a heartbeat proves
  the device is alive and the counter did not move, Offline when the device is
  silent. Down comes from a maintenance dispatch.
- Double counting: `workCenterDevice.countMode` is `Off` or `Auto`. In Auto
  the sensor owns Production; MES refuses a manual Production entry without a
  supervisor override, and scrap the sensor counted is reclassified.
- A Planned maintenance dispatch is a planned stop for OEE; a Down dispatch is
  an Availability loss.

## Progress

### Phase 0 — hardware bench (user)
- [ ] ESP32 + opto input + one 24 V PNP sensor on a signal generator
- [ ] 10,000 pulses counted with 0 error; 1 ms chatter rejected
- [ ] 30 minutes without network replays in order, with no duplicates

### Phase 1 — broker, ingest, provider, badge
- [x] `apps/pulse-ingest` pure core: MQTT contract (`protocol.ts`), bucket
      times (`time.ts`), lost buckets (`gaps.ts`), state inference
      (`state.ts`), with tests
- [x] Migration: `pulseDevice`, `pulseCount`, `pulseStateChange`,
      `pulseIngestStatus`, `integration('pulse')` with `providerRole = 'oee'`,
      authz manifest rules, retention crons
      (`20261114131742_pulse-machine-monitor.sql`, `20261114134325_pulse-machine-monitor-rls.sql`)
- [x] `pnpm db:migrate` + `pnpm run generate:types` (needs the local stack)
- [x] Ingest runtime: MQTT client, Kysely writes, `carbon/oee-device-sync`
      events to Inngest, heartbeat row
- [x] Provider: `OeeProviderId` gains `pulse`; the registry factory takes
      `{ companyId, serviceClient }`; `packages/ee/src/pulse/{config,provider,hooks.server}`
- [x] ERP: Pulse Devices tab (`PulseDevices.ee.tsx`)
- [x] Compose: `mosquitto` + `pulse-ingest` services, `pulse-ingest.Dockerfile`,
      `.env.example`, `CARBON_EDITION=enterprise`, deployment rule + README
- [x] Docs: `oee-provider.md`, `packages/ee/AGENTS.md`, the spec
- [x] Lingui: the Pulse Devices strings extracted and translated (12 locales)
- [x] Log scrap push switch and send-each-pulse mode: MQTT `scrap` /
      `scrapTotal`, `config.sendEachPulse`, migration
      `20261115143849_pulse-scrap-and-send-mode.sql`, ingest, Pulse Devices
      switch
- [x] Device simulator: `apps/pulse-ingest/src/simulator/`
      (`pnpm --filter pulse-ingest simulate`), checked end to end on
      2026-11-15
- [ ] Accept: badge shows Running, Idle and Offline for one mapped machine;
      healthcheck fails when ingest stops

### Phase 2 — machine time and the unattributed queue
- [ ] Map 1 to 3 machines; verify Machine events, Unattributed Time,
      maintenance blocks and the minimum state on real data

### Phase 3 — automatic quantities
- [ ] Migration: `productionQuantity.source`, `workCenterDevice.countMode` and
      `countedThrough`, `machineCountPosting`, `unattributedMachineCount`,
      the two purge functions redefined
- [x] Decide the tracking label: see the spec, "API / Service Changes"
      (decided 2026-11-16)
- [ ] Migration: `workCenterDevice.labelEveryQuantity` (batch label per N pieces)
- [ ] `planMachineCounts` (`packages/ee/src/oee/counts.ts`) with tests:
      Log completed = (pulses − scrapPulses) × piecesPerPulse, Log scrap =
      scrapPulses × piecesPerPulse
- [ ] Post at once for a device with `sendEachPulse`, and print the label
      (`autoPrintOperationLabel`)
- [ ] Count step after `syncOeeDevice` (`oee-sync-device-counts.ts`)
- [ ] MES Auto mode: `complete.tsx` refusal + override, `scrap.tsx` reclassify
- [ ] ERP: Unattributed Counts page

### Phase 4 — OEE screens
- [x] `@carbon/planning/oee` pure subpath; window helpers moved out of
      `production.service.ts` (plan `.ai/plans/2026-11-17-oee-dashboard.md`)
- [x] ERP Production → OEE (`x+/production+/oee.tsx`, `api+/production.oee.ts`)
- [x] MES `display+/$workCenterId.oee.tsx`

### Phase 5 — optional
- [ ] OTA, database-backed broker auth, Confirm count mode

## Validation

```bash
pnpm --filter pulse-ingest test && pnpm --filter pulse-ingest typecheck
pnpm --filter @carbon/ee test
pnpm --filter @carbon/jobs test
pnpm exec turbo run typecheck --filter=erp --filter=mes --concurrency=1
pnpm --filter @carbon/checks test
pnpm run lint
pnpm db:check:datasets && pnpm db:check:backups
```

## Run notes

- 2026-11-14: The local stack runs on Windows after 4 fixes in `crbn` and the
  scripts (docker compose plugin env, env file links, the Supabase CLI path,
  LF shell scripts) and 1 in `authz migration`. This checkout now uses
  `core.autocrlf=input`, because CRLF copies of the migrations broke the authz
  generator's text comparison.
- 2026-11-14: `authz migration` names its file with a UTC timestamp. The table
  migration must sort before it, so its timestamp is earlier.

- 2026-11-14: Phase 1 core written first because the machine had no Docker
  daemon and no `.env`, so no migration could be applied and no types
  generated. `@carbon/config` had to be built once (`pnpm --filter
  @carbon/config build`) before vitest could load its shared config.
- 2026-11-14: The Pulse Devices tab shows for an OEE descriptor with
  `registersDevices: true`, not for the id `pulse`. The writes are in
  `@carbon/ee/pulse/devices.server`, because the API reads `pulseDevice` only.
- 2026-11-14: The broker and the ingest service are in the compose profile
  `pulse`. The broker publishes 1883 on `MQTT_PUBLISH_ADDRESS` only (default
  `127.0.0.1`). A local smoke test passed: anonymous refused, the ACL drops an
  off-namespace topic, and the built ingest image connects and starts.
- 2026-11-14: On Windows, `turbo run typecheck --filter=erp` fails at
  `generate:mcp`, because cmd.exe cannot run `NODE_OPTIONS=… cmd`. Run the
  script and `tsc --noEmit` in `apps/erp` through Git Bash instead.
- 2026-11-14: A simulated run with 2 devices (`sim-cnc`, `sim-tig`) passed
  the state part of the Phase 1 acceptance: Running, Idle, Running, Offline,
  and Machine events on the mapped work centers. The sync was driven by a
  throwaway vitest driver, not Inngest. The real-device check is still open.
- 2026-11-15: The translate run filled only the 29 new Pulse strings. The
  catalogs still hold empty `msgstr` from before this branch; they are out of
  scope here.
- 2026-11-15: The device gets a Log scrap push switch (no Log completed
  button: the sensor is the completion count) and a send-each-pulse mode for
  long cycles, because the user wants a tracking label printed from each
  sensor Log completed. A simulator page replaces the throwaway sync driver.
  On Windows, `pnpm db:migrate` fails in cmd.exe; run
  `bash packages/dev/bin/crbn migrate`.
