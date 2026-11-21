// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { zfd } from "zod-form-data";
import { getDatabaseClient } from "~/services/database.server";
import {
  endOperationStop,
  type OperationStopRefusal,
  startOperationStop
} from "~/services/operation-stops.service";
import { postEndedProductionEvents } from "~/services/operations.service";

export const operationStopValidator = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("start"),
    jobOperationId: zfd.text(z.string()),
    stopReasonId: zfd.text(z.string({ message: "Pick a reason" })),
    notes: zfd.text(z.string().optional())
  }),
  z.object({
    intent: z.literal("end"),
    jobOperationId: zfd.text(z.string())
  })
]);

const REFUSALS: Record<OperationStopRefusal, string> = {
  "not-found": "The operation could not be found",
  "already-stopped": "This operation is already stopped",
  "not-stopped": "This operation is not stopped",
  "reason-not-found": "The stop reason could not be found"
};

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  // Stops close and open Machine events, so they need the same permission
  // as the Machine button.
  const { companyId, userId } = await requirePermissions(request, {
    update: "production"
  });

  const validation = await validator(operationStopValidator).validate(
    await request.formData()
  );
  if (validation.error) return validationError(validation.error);

  const input = validation.data;
  const db = getDatabaseClient();

  try {
    const result =
      input.intent === "start"
        ? await startOperationStop(db, {
            companyId,
            userId,
            jobOperationId: input.jobOperationId,
            stopReasonId: input.stopReasonId,
            notes: input.notes
          })
        : await endOperationStop(db, {
            companyId,
            userId,
            jobOperationId: input.jobOperationId
          });

    if (!result.ok) {
      return data(
        { success: false },
        await flash(request, error(null, REFUSALS[result.reason]))
      );
    }

    await postEndedProductionEvents(getCarbonServiceRole(), {
      companyId,
      userId,
      ids: result.endedEventIds
    });

    return data(
      { success: true },
      await flash(
        request,
        success(input.intent === "start" ? "Stop logged" : "Resumed")
      )
    );
  } catch (err) {
    return data(
      { success: false },
      await flash(
        request,
        error(
          err,
          input.intent === "start"
            ? "Failed to log the stop"
            : "Failed to resume",
          { jobOperationId: input.jobOperationId }
        )
      )
    );
  }
}
