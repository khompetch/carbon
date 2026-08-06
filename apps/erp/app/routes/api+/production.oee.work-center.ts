import { requirePermissions } from "@carbon/auth/auth.server";
import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { getWorkCenterHourlyOee } from "~/modules/production/production.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "production"
  });

  const url = new URL(request.url);
  const workCenterId = url.searchParams.get("workCenterId");
  if (!workCenterId) {
    return data({ error: "workCenterId is required", data: null }, 400);
  }

  return await getWorkCenterHourlyOee(client, {
    workCenterId,
    companyId,
    date: url.searchParams.get("date"),
    shiftId: url.searchParams.get("shiftId")
  });
}
