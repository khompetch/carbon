// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { error, notFound, success } from "@carbon/auth";
import { authorize } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { useRouteDialog } from "@carbon/react";
import { getDatabaseErrorMessage, redirect } from "@carbon/utils";
import { useLingui } from "@lingui/react/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useParams } from "react-router";
import { ConfirmDelete } from "~/components/Modals";
import {
  deleteStopReason,
  getStopReason
} from "~/modules/production/production.service";
import { getParams, path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client } = await authorize(request, {
    "production.stopReasons": "View"
  });
  const { stopReasonId } = params;
  if (!stopReasonId) throw notFound("stopReasonId not found");

  const stopReason = await getStopReason(client, stopReasonId);
  if (stopReason.error) {
    throw redirect(
      `${path.to.stopReasons}?${getParams(request)}`,
      await flash(request, error(stopReason.error, "Failed to get stop reason"))
    );
  }

  return { stopReason: stopReason.data };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { client } = await authorize(request, {
    "production.stopReasons": "Full"
  });

  const { stopReasonId } = params;
  if (!stopReasonId) {
    throw redirect(
      `${path.to.stopReasons}?${getParams(request)}`,
      await flash(request, error(null, "Failed to get a stop reason id"))
    );
  }

  const { error: deleteStopReasonError } = await deleteStopReason(
    client,
    stopReasonId
  );
  if (deleteStopReasonError) {
    const errorMessage = getDatabaseErrorMessage(
      deleteStopReasonError,
      "Failed to delete stop reason",
      { referenced: "Stop reason is used elsewhere, cannot delete" }
    );

    throw redirect(
      `${path.to.stopReasons}?${getParams(request)}`,
      await flash(request, error(deleteStopReasonError, errorMessage))
    );
  }

  throw redirect(
    `${path.to.stopReasons}?${getParams(request)}`,
    await flash(request, success("Successfully deleted stop reason"))
  );
}

export default function DeleteStopReasonRoute() {
  const { stopReasonId } = useParams();
  const { stopReason } = useLoaderData<typeof loader>();
  const dialog = useRouteDialog(path.to.stopReasons);
  const { t } = useLingui();

  if (!stopReason) return null;
  if (!stopReasonId) throw notFound("stopReasonId not found");

  return (
    <ConfirmDelete
      action={path.to.deleteStopReason(stopReasonId)}
      name={stopReason.name}
      text={t`Are you sure you want to delete the stop reason: ${stopReason.name}? This cannot be undone.`}
      isOpen={dialog.open}
      onCancel={dialog.close}
    />
  );
}
