import { assertIsPost } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { userContext } from "~/context";
import {
  endOpenDowntime,
  getDowntimeReasonsList,
  getOpenDowntime,
  startDowntime
} from "~/services/operations.service";

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {});

  const url = new URL(request.url);
  const workCenterId = url.searchParams.get("workCenterId");

  const [reasons, openDowntime] = await Promise.all([
    getDowntimeReasonsList(client, companyId),
    workCenterId
      ? getOpenDowntime(client, workCenterId, companyId)
      : Promise.resolve({ data: null, error: null })
  ]);

  return {
    reasons: reasons.data ?? [],
    openDowntime: openDowntime.data ?? null
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {});
  const effectiveUserId = context.get(userContext)?.effectiveUserId ?? userId;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const workCenterId = formData.get("workCenterId") as string;

  if (!workCenterId) {
    return { success: false, message: "Missing workCenterId" };
  }

  if (intent === "start") {
    const downtimeReasonId = formData.get("downtimeReasonId") as string;
    const type = formData.get("downtimeType") as "Planned" | "Unplanned";
    const notes = (formData.get("notes") as string) ?? "";

    if (!downtimeReasonId || !type) {
      return { success: false, message: "Downtime reason is required" };
    }

    // A work center has at most one open downtime — close any leftover first
    await endOpenDowntime(client, {
      workCenterId,
      companyId,
      userId: effectiveUserId
    });

    const result = await startDowntime(client, {
      workCenterId,
      downtimeReasonId,
      type,
      notes,
      companyId,
      userId: effectiveUserId
    });

    if (result.error) {
      return { success: false, message: "Failed to start downtime" };
    }

    return { success: true, message: "Downtime started" };
  }

  if (intent === "end") {
    const result = await endOpenDowntime(client, {
      workCenterId,
      companyId,
      userId: effectiveUserId
    });

    if (result.error) {
      return { success: false, message: "Failed to end downtime" };
    }

    return { success: true, message: "Downtime ended" };
  }

  return { success: false, message: "Invalid intent" };
}
