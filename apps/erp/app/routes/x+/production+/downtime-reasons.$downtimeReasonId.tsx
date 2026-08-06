import { assertIsPost, error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, redirect, useLoaderData, useNavigate } from "react-router";
import {
  downtimeReasonValidator,
  getDowntimeReason,
  upsertDowntimeReason
} from "~/modules/production";
import DowntimeReasonForm from "~/modules/production/ui/DowntimeReasons/DowntimeReasonForm";
import { getCustomFields, setCustomFields } from "~/utils/form";
import { path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client } = await requirePermissions(request, {
    view: "production",
    role: "employee"
  });

  const { downtimeReasonId } = params;
  if (!downtimeReasonId) throw notFound("downtimeReasonId not found");

  const downtimeReason = await getDowntimeReason(client, downtimeReasonId);

  if (downtimeReason.error) {
    throw redirect(
      path.to.downtimeReasons,
      await flash(
        request,
        error(downtimeReason.error, "Failed to get downtime reason")
      )
    );
  }

  return {
    downtimeReason: downtimeReason.data
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, userId } = await requirePermissions(request, {
    update: "production"
  });

  const formData = await request.formData();
  const validation = await validator(downtimeReasonValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id, ...d } = validation.data;
  if (!id) throw new Error("id not found");

  const updateDowntimeReason = await upsertDowntimeReason(client, {
    id,
    ...d,
    updatedBy: userId,
    customFields: setCustomFields(formData)
  });

  if (updateDowntimeReason.error) {
    return data(
      {},
      await flash(
        request,
        error(updateDowntimeReason.error, "Failed to update downtime reason")
      )
    );
  }

  throw redirect(
    path.to.downtimeReasons,
    await flash(request, success("Updated downtime reason"))
  );
}

export default function EditDowntimeReasonRoute() {
  const { downtimeReason } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const initialValues = {
    id: downtimeReason?.id ?? undefined,
    name: downtimeReason?.name ?? "",
    type: downtimeReason?.type ?? ("Unplanned" as const),
    ...getCustomFields(downtimeReason?.customFields)
  };

  return (
    <DowntimeReasonForm
      key={initialValues.id}
      initialValues={initialValues}
      onClose={() => navigate(-1)}
    />
  );
}
