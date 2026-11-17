# OEE screens (ERP Production → OEE, MES OEE board)

Last tested: 2026-11-17
Routes: `/x/production/oee`, `/api/production/oee`, MES `/display/$workCenterId/oee`
Tracking spec: `.ai/specs/2026-11-14-oee-dashboard.md`

## Prerequisites
- Dev stack up (`crbn up`), or the ERP and MES dev servers started by hand
  (`pnpm exec react-router dev --port 3000` in `apps/erp`, `--port 3001` in `apps/mes`).
  The first ERP request takes about 2 minutes on Windows while Vite bundles.
- Authenticated via `/auth` (DEV_BYPASS_EMAIL=test@carbon.ms). MES on the same
  host shares the cookie.
- An active OEE integration (Pulse), else the nav item is hidden.
- Data: the Pulse simulator devices `sim-cnc` (CNC Mill) and `sim-tig`
  (TIG Welder Cell) at location `loc_Xq48FU3Sjy4roc4p35DXrV` (America/Chicago).
  Both work centers link to the Day Shift only (06:00–14:30, Mon–Tue).

## Steps
1. Open `/x/production/oee?locationId=loc_Xq48FU3Sjy4roc4p35DXrV`.
   Expect 4 cards, "OEE by day", and the work center table with a Source badge
   (Sensor for CNC Mill and TIG Welder Cell, Operator for the rest).
2. Compare the pieces with the raw buckets. In the browser:
   `fetch('/api/production/oee?locationId=…&start=2026-11-11&end=2026-11-17').then(r=>r.json())`
   and read `workCenters[].parts.totalPieces`. In psql:
   `SELECT d."deviceKey", sum(c.pulses)*d."piecesPerPulse" FROM "pulseCount" c JOIN "pulseDevice" d ON d.id=c."pulseDeviceId" WHERE c."periodEnd" >= '2026-11-11 06:00+00' GROUP BY 1, d."piecesPerPulse";`
   They must agree (2026-11-17: 248 = 248, 76 = 76).
3. Bad pieces = sensor scrap + the manual Scrap/Rework rows without a
   `Pulse sensor ` note (2026-11-17: CNC 14 + 1 = 15).
4. Screenshot at 1440, 1024 and 390 px. The table scrolls inside its card; the
   time cells do not wrap.
5. Open MES `/display`. Each work center row has an "OEE" link. Click CNC Mill.
   Between shifts the board shows the shift that ended last
   (`06:00 AM – 02:30 PM`) with its planned time.

## Known noise
- Performance far over 100 % on CNC Mill: its operation standard is
  3.5 Hours/Piece while the simulator pulses every few seconds. The math is right.
- "This Suspense boundary received an update before it finished hydrating"
  shows on every Production page (Unattributed Time too); not from the OEE page.
