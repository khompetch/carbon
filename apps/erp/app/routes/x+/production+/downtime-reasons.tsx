import { requirePermissions } from "@carbon/auth/auth.server";
import { VStack } from "@carbon/react";
import { msg } from "@lingui/core/macro";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { getDowntimeReasons } from "~/modules/production";
import DowntimeReasonsTable from "~/modules/production/ui/DowntimeReasons/DowntimeReasonsTable";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";
import { getGenericQueryFilters } from "~/utils/query";

export const handle: Handle = {
  breadcrumb: msg`Downtime Reasons`,
  to: path.to.downtimeReasons
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "production",
    role: "employee"
  });

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);
  const search = searchParams.get("search");
  const { limit, offset, sorts, filters } =
    getGenericQueryFilters(searchParams);

  return await getDowntimeReasons(client, companyId, {
    search,
    limit,
    offset,
    sorts,
    filters
  });
}

export default function DowntimeReasonsRoute() {
  const { data, count } = useLoaderData<typeof loader>();

  return (
    <VStack spacing={0} className="h-full">
      <DowntimeReasonsTable data={data ?? []} count={count ?? 0} />
      <Outlet />
    </VStack>
  );
}
