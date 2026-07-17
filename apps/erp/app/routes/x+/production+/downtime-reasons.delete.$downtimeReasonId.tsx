import { error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { useLingui } from "@lingui/react/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useParams } from "react-router";
import { ConfirmDelete } from "~/components/Modals";
import { deleteDowntimeReason, getDowntimeReason } from "~/modules/production";
import { getParams, path } from "~/utils/path";

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
      `${path.to.downtimeReasons}?${getParams(request)}`,
      await flash(
        request,
        error(downtimeReason.error, "Failed to get downtime reason")
      )
    );
  }

  return { downtimeReason: downtimeReason.data };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { client } = await requirePermissions(request, {
    delete: "production"
  });

  const { downtimeReasonId } = params;
  if (!downtimeReasonId) {
    throw redirect(
      `${path.to.downtimeReasons}?${getParams(request)}`,
      await flash(request, error(params, "Failed to get a downtime reason id"))
    );
  }

  const { error: deleteDowntimeReasonError } = await deleteDowntimeReason(
    client,
    downtimeReasonId
  );
  if (deleteDowntimeReasonError) {
    const errorMessage =
      deleteDowntimeReasonError.code === "23503"
        ? "Downtime reason is used elsewhere, cannot delete"
        : "Failed to delete downtime reason";

    throw redirect(
      `${path.to.downtimeReasons}?${getParams(request)}`,
      await flash(request, error(deleteDowntimeReasonError, errorMessage))
    );
  }

  throw redirect(
    `${path.to.downtimeReasons}?${getParams(request)}`,
    await flash(request, success("Successfully deleted downtime reason"))
  );
}

export default function DeleteDowntimeReasonRoute() {
  const { downtimeReasonId } = useParams();
  const { downtimeReason } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useLingui();

  if (!downtimeReason) return null;
  if (!downtimeReasonId) throw notFound("downtimeReasonId not found");

  const onCancel = () => navigate(path.to.downtimeReasons);
  return (
    <ConfirmDelete
      action={path.to.deleteDowntimeReason(downtimeReasonId)}
      name={downtimeReason.name}
      text={t`Are you sure you want to delete the downtime reason: ${downtimeReason.name}? This cannot be undone.`}
      onCancel={onCancel}
    />
  );
}
