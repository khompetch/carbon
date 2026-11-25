// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { assertIsPost, error, success } from "@carbon/auth";
import { authorize } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import { useRouteDialog } from "@carbon/react";
import { redirect } from "@carbon/utils";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { stopReasonValidator } from "~/modules/production/production.models";
import { upsertStopReason } from "~/modules/production/production.service";
import StopReasonForm from "~/modules/production/ui/StopReasons/StopReasonForm";
import { setCustomFields } from "~/utils/form";
import { getParams, path, requestReferrer } from "~/utils/path";

export async function loader({ request }: LoaderFunctionArgs) {
  await authorize(request, {
    "production.stopReasons": "Create"
  });

  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await authorize(request, {
    "production.stopReasons": "Create"
  });

  const formData = await request.formData();
  const modal = formData.get("type") === "modal";

  const validation = await validator(stopReasonValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id: _id, ...d } = validation.data;

  const insertStopReason = await upsertStopReason(client, {
    ...d,
    companyId,
    createdBy: userId,
    customFields: setCustomFields(formData)
  });
  if (insertStopReason.error) {
    return modal
      ? insertStopReason
      : redirect(
          requestReferrer(request) ??
            `${path.to.stopReasons}?${getParams(request)}`,
          await flash(
            request,
            error(insertStopReason.error, "Failed to insert stop reason")
          )
        );
  }

  return modal
    ? insertStopReason
    : redirect(
        `${path.to.stopReasons}?${getParams(request)}`,
        await flash(request, success("Stop reason created"))
      );
}

export default function NewStopReasonRoute() {
  const dialog = useRouteDialog();
  const initialValues = {
    name: ""
  };

  return (
    <StopReasonForm
      initialValues={initialValues}
      open={dialog.open}
      onClose={dialog.close}
    />
  );
}
