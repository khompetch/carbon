import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useNavigate } from "react-router";
import {
  downtimeReasonValidator,
  upsertDowntimeReason
} from "~/modules/production";
import DowntimeReasonForm from "~/modules/production/ui/DowntimeReasons/DowntimeReasonForm";
import { setCustomFields } from "~/utils/form";
import { getParams, path, requestReferrer } from "~/utils/path";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermissions(request, {
    create: "production"
  });

  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    create: "production"
  });

  const formData = await request.formData();

  const validation = await validator(downtimeReasonValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  // biome-ignore lint/correctness/noUnusedVariables: id is stripped for insert
  const { id, ...d } = validation.data;

  const insertDowntimeReason = await upsertDowntimeReason(client, {
    ...d,
    companyId,
    createdBy: userId,
    customFields: setCustomFields(formData)
  });
  if (insertDowntimeReason.error) {
    return redirect(
      requestReferrer(request) ??
        `${path.to.downtimeReasons}?${getParams(request)}`,
      await flash(
        request,
        error(insertDowntimeReason.error, "Failed to insert downtime reason")
      )
    );
  }

  return redirect(
    `${path.to.downtimeReasons}?${getParams(request)}`,
    await flash(request, success("Downtime reason created"))
  );
}

export default function NewDowntimeReasonRoute() {
  const navigate = useNavigate();
  const initialValues = {
    name: "",
    type: "Unplanned" as const
  };

  return (
    <DowntimeReasonForm
      initialValues={initialValues}
      onClose={() => navigate(-1)}
    />
  );
}
