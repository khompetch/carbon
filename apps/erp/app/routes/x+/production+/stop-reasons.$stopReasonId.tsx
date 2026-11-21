// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { assertIsPost, error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import { useRouteDialog } from "@carbon/react";
import { redirect } from "@carbon/utils";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { stopReasonValidator } from "~/modules/production/production.models";
import {
  getStopReason,
  upsertStopReason
} from "~/modules/production/production.service";
import StopReasonForm from "~/modules/production/ui/StopReasons/StopReasonForm";
import { getCustomFields, setCustomFields } from "~/utils/form";
import { path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client } = await requirePermissions(request, {
    view: "production",
    role: "employee"
  });

  const { stopReasonId } = params;
  if (!stopReasonId) throw notFound("stopReasonId not found");

  const stopReason = await getStopReason(client, stopReasonId);

  if (stopReason.error) {
    throw redirect(
      path.to.stopReasons,
      await flash(request, error(stopReason.error, "Failed to get stop reason"))
    );
  }

  return {
    stopReason: stopReason.data
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, userId } = await requirePermissions(request, {
    update: "production"
  });

  const formData = await request.formData();
  const validation = await validator(stopReasonValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id, ...d } = validation.data;
  if (!id) throw new Error("id not found");

  const updateStopReason = await upsertStopReason(client, {
    id,
    ...d,
    updatedBy: userId,
    customFields: setCustomFields(formData)
  });

  if (updateStopReason.error) {
    return data(
      {},
      await flash(
        request,
        error(updateStopReason.error, "Failed to update stop reason")
      )
    );
  }

  throw redirect(
    path.to.stopReasons,
    await flash(request, success("Updated stop reason"))
  );
}

export default function EditStopReasonRoute() {
  const { stopReason } = useLoaderData<typeof loader>();
  const dialog = useRouteDialog();

  const initialValues = {
    id: stopReason.id ?? undefined,
    name: stopReason.name ?? "",
    oeeLoss: stopReason.oeeLoss,
    ...getCustomFields(stopReason.customFields)
  };

  return (
    <StopReasonForm
      key={initialValues.id}
      initialValues={initialValues}
      open={dialog.open}
      onClose={dialog.close}
    />
  );
}
