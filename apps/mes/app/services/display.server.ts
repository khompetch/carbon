// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// Server-only reads of the work center displays. `display.service.ts` reaches
// the browser (components import it), so it never imports a `.server` module.

import type { Database } from "@carbon/database";
import {
  computeOeeParts,
  currentShiftPeriod,
  type Interval,
  localDayPeriod,
  type OeeParts,
  type OeeRatios,
  oeeRatios
} from "@carbon/planning/oee";
import { loadOeeWorkCenters } from "@carbon/planning/oee/load.server";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

const DAY_MS = 24 * 3_600_000;

/**
 * The OEE board of one work center: the current shift, from its start to now
 * (between shifts, the shift that ended last). A work center that runs around
 * the clock, or has no shift, shows the current local day.
 */
export async function getOeeDisplayData(
  client: SupabaseClient<Database>,
  args: {
    workCenterId: string;
    companyId: string;
    timeZone: string;
    now: number;
  }
): Promise<{
  data: { period: Interval; parts: OeeParts; ratios: OeeRatios } | null;
  error: PostgrestError | null;
}> {
  const today = localDayPeriod(args.now, args.timeZone);
  // One day of margin, so a shift that started yesterday evening is whole.
  const loaded = await loadOeeWorkCenters(client, {
    companyId: args.companyId,
    workCenterIds: [args.workCenterId],
    from: today.start - DAY_MS,
    to: args.now,
    now: args.now,
    timeZone: args.timeZone
  });
  if (loaded.error) return { data: null, error: loaded.error };
  const workCenter = loaded.data[0];
  if (!workCenter) return { data: null, error: null };

  const period =
    (workCenter.alwaysOn
      ? null
      : currentShiftPeriod(workCenter.workingWindows, args.now)) ?? today;
  const parts = computeOeeParts({ ...workCenter.input, period });
  return { data: { period, parts, ratios: oeeRatios(parts) }, error: null };
}
