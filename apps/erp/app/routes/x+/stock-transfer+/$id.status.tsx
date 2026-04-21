import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import {
  stockTransferStatusType,
  updateStockTransferStatus
} from "~/modules/inventory";
import { path, requestReferrer } from "~/utils/path";

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, userId } = await requirePermissions(request, {
    update: "inventory"
  });

  const { id } = params;
  if (!id) throw new Error("Could not find id");

  const formData = await request.formData();
  const status = formData.get(
    "status"
  ) as (typeof stockTransferStatusType)[number];

  if (!status || !stockTransferStatusType.includes(status)) {
    throw redirect(
      requestReferrer(request) ?? path.to.stockTransfer(id),
      await flash(request, error(null, "Invalid status"))
    );
  }

  const update = await updateStockTransferStatus(client, {
    id,
    status,
    assignee: ["Completed"].includes(status) ? null : undefined,
    completedAt: ["Completed"].includes(status)
      ? new Date().toISOString()
      : null,
    updatedBy: userId
  });
  if (update.error) {
    throw redirect(
      requestReferrer(request) ?? path.to.stockTransfer(id),
      await flash(request, error(update.error, "Failed to update issue status"))
    );
  }

  throw redirect(
    requestReferrer(request) ?? path.to.stockTransfer(id),
    await flash(request, success("Updated issue status"))
  );
}
