// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

/**
 * The Unattributed Counts list's search and filters, read from the URL. The
 * list and the review queue both apply them, so the queue walks the rows the
 * list shows. Pure: no database, no Lingui.
 *
 * The list has no date filters: the table has no view with the period's
 * days in the location's timezone, as Unattributed Time has.
 */

import type { Database } from "@carbon/database";

export type UnattributedMachineCountReason =
  Database["public"]["Enums"]["unattributedMachineCountReason"];

export const unattributedMachineCountReasons = [
  "NoLoad",
  "Blocked",
  "OperationClosed",
  "OverTarget",
  "SerialNeedsSendEachPulse",
  "NoScrapReason",
  "Refused"
] as const satisfies readonly UnattributedMachineCountReason[];

export type MachineCountListFilters = {
  search: string | null;
  workCenterIds: string[];
  locationIds: string[];
  reasons: UnattributedMachineCountReason[];
};

function isReason(value: string): value is UnattributedMachineCountReason {
  return (unattributedMachineCountReasons as readonly string[]).includes(value);
}

export function parseMachineCountListFilters(
  searchParams: URLSearchParams
): MachineCountListFilters {
  const filters: MachineCountListFilters = {
    search: searchParams.get("search") || null,
    workCenterIds: [],
    locationIds: [],
    reasons: []
  };

  for (const filter of searchParams.getAll("filter")) {
    const [column, operator, value] = filter.split(":");
    if (!column || !operator || !value) continue;

    switch (column) {
      case "workCenterId":
        filters.workCenterIds = value.split(",").filter(Boolean);
        break;
      case "locationId":
        filters.locationIds = value.split(",").filter(Boolean);
        break;
      case "reason":
        filters.reasons = value.split(",").filter(isReason);
        break;
    }
  }

  return filters;
}

/**
 * PostgREST `or` filters for the rows above and below a row in the queue's
 * order (newest period start first, then `id`, both descending). A tie on
 * `periodStart` falls to `id`, so every row has exactly one place.
 */
export function machineCountQueueKeyset(row: {
  id: string;
  periodStart: string;
}) {
  const at = `"${row.periodStart}"`;
  return {
    above: `periodStart.gt.${at},and(periodStart.eq.${at},id.gt.${row.id})`,
    below: `periodStart.lt.${at},and(periodStart.eq.${at},id.lt.${row.id})`
  };
}
