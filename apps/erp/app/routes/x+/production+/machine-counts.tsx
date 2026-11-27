// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { error } from "@carbon/auth";
import { authorize } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { getLogger } from "@carbon/logger";
import { RecordOutlet, VStack } from "@carbon/react";
import { redirect } from "@carbon/utils";
import { msg } from "@lingui/core/macro";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { usePlanGate } from "~/hooks/usePlanGate";
import {
  getUnattributedMachineCounts,
  UNATTRIBUTED_MACHINE_COUNTS_PAGING
} from "~/modules/production/production.service";
import MachineCountTable from "~/modules/production/ui/MachineCounts/MachineCountTable.ee";
import MachineCountUpgradeOverlay from "~/modules/production/ui/MachineCounts/MachineCountUpgradeOverlay.ee";
import { parseMachineCountListFilters } from "~/modules/production/ui/MachineCounts/machine-count-filters.ee";
import { getWorkCentersList } from "~/modules/resources/resources.service";
import { toPage } from "~/utils/cursor";
import type { Handle } from "~/utils/handle";
import { listErrorPage } from "~/utils/list-registry/load.server";
import { path } from "~/utils/path";
import { getGenericQueryFilters } from "~/utils/query";

const logger = getLogger("erp", "machine-counts");

export const handle: Handle = {
  breadcrumb: msg`Unattributed Counts`,
  to: path.to.unattributedMachineCounts
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId, api } = await authorize(request, {
    "production.unattributedTime": "View"
  });

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);
  const { limit, cursor } = getGenericQueryFilters(searchParams);
  const filters = parseMachineCountListFilters(searchParams);

  const [machineCounts, workCenters, locations] = await Promise.all([
    getUnattributedMachineCounts(client, companyId, { filters, limit, cursor }),
    getWorkCentersList(client, companyId),
    api.resources.getLocationsList({})
  ]);

  if (machineCounts.error) {
    if (cursor) {
      logger.error(
        "Failed to load a later page of unattributed machine counts",
        { companyId, error: machineCounts.error }
      );
      return listErrorPage("machineCounts");
    }
    throw redirect(
      path.to.production,
      await flash(
        request,
        error(machineCounts.error, "Failed to load unattributed machine counts")
      )
    );
  }

  const page = toPage(
    machineCounts.data ?? [],
    { limit, sorts: [] },
    UNATTRIBUTED_MACHINE_COUNTS_PAGING
  );

  return {
    machineCounts: page.rows,
    count: machineCounts.count ?? 0,
    nextCursor: page.nextCursor,
    workCenters: workCenters.data ?? [],
    locations: locations.data ?? []
  };
}

export default function MachineCountsRoute() {
  const { machineCounts, count, nextCursor, workCenters, locations } =
    useLoaderData<typeof loader>();
  const { isGated } = usePlanGate({ feature: "INTEGRATIONS" });

  if (isGated) {
    return <MachineCountUpgradeOverlay />;
  }

  return (
    <VStack spacing={0} className="h-full">
      <MachineCountTable
        data={machineCounts}
        count={count}
        nextCursor={nextCursor}
        workCenters={workCenters}
        locations={locations}
      />
      <RecordOutlet />
    </VStack>
  );
}
