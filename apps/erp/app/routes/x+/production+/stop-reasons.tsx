// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { RecordOutlet, VStack } from "@carbon/react";
import { msg } from "@lingui/core/macro";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import StopReasonsTable from "~/modules/production/ui/StopReasons/StopReasonsTable";
import type { Handle } from "~/utils/handle";
import { loadListPage } from "~/utils/list-registry/load.server";
import { stopReasonsList } from "~/utils/list-registry/production.server";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Stop Reasons`,
  to: path.to.stopReasons
};

export async function loader({ request }: LoaderFunctionArgs) {
  return loadListPage(request, stopReasonsList, { dataKey: "data" });
}

export default function StopReasonsRoute() {
  const { data, count, infinite } = useLoaderData<typeof loader>();

  return (
    <VStack spacing={0} className="h-full">
      <StopReasonsTable data={data} count={count} infinite={infinite} />
      <RecordOutlet />
    </VStack>
  );
}
