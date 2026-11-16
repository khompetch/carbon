// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import {
  lowerSensorProduction,
  restoreSensorProduction,
  type SensorProductionChange
} from "@carbon/database/machine-counts";
import { validationError, validator } from "@carbon/form";
import { getLogger } from "@carbon/logger";
import { EPSILON, round } from "@carbon/utils";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { getDatabaseClient } from "~/services/database.server";
import { erpPosting } from "~/services/erp";
import { scrapQuantityValidator } from "~/services/models";
import { abilityBlockRefusal } from "~/services/operations.service";

const log = getLogger("mes", "scrap");

const SENSOR_SHORTFALL =
  "The sensor has not counted that many pieces on this operation.";

class SensorShortfallError extends Error {}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { companyId, userId } = await requirePermissions(request, {});

  const formData = await request.formData();
  const validation = await validator(scrapQuantityValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const {
    trackedEntityId,
    trackingType,
    jobOperationId,
    quantity,
    scrapReasonId,
    notes,
    countedBySensor,
    setupProductionEventId,
    laborProductionEventId,
    machineProductionEventId
  } = validation.data;

  const serviceRole = await getCarbonServiceRole();
  const refusal = await abilityBlockRefusal(serviceRole, {
    operationId: jobOperationId,
    employeeId: userId,
    companyId
  });
  if (refusal) {
    return data({}, await flash(request, error(null, refusal)));
  }

  // The scrapped pieces are among those the sensor counted as Production:
  // lower the sensor's Production first, so the scrap posting's backflush
  // (complete + scrapped units) issues no extra material. A serial unit is
  // named by the operator and is not lowered here.
  let sensorChanges: SensorProductionChange[] = [];
  if (countedBySensor && trackingType !== "Serial") {
    try {
      sensorChanges = await getDatabaseClient()
        .transaction()
        .execute(async (trx) => {
          const { lowered, changes } = await lowerSensorProduction(trx, {
            companyId,
            jobOperationId,
            quantity,
            userId
          });
          // Throw inside the transaction so the lowered rows roll back.
          if (round(quantity) - lowered > EPSILON) {
            throw new SensorShortfallError();
          }
          return changes;
        });
    } catch (err) {
      if (err instanceof SensorShortfallError) {
        log.info("Scrap refused: the sensor counted fewer pieces", {
          companyId,
          jobOperationId,
          quantity
        });
        return data({}, await flash(request, error(null, SENSOR_SHORTFALL)));
      }
      log.error("Failed to lower the sensor's Production", {
        companyId,
        jobOperationId,
        quantity,
        error: err
      });
      return data(
        {},
        await flash(request, error(err, "Failed to record scrap quantity"))
      );
    }
  }

  // One transactional posting: Scrap productionQuantity row, BOM
  // backflush, tracked-entity terminal status + replacement serial spawn
  // (serial parents), Done-operation reopen / capacity top-up beyond the
  // planned allowance, and the WIP→scrap journal.
  const issued = await erpPosting(
    "issue",
    { companyId, userId },
    {
      type: "jobOperationScrap",
      jobOperationId,
      quantity,
      scrapReasonId,
      notes,
      setupProductionEventId,
      laborProductionEventId,
      machineProductionEventId,
      trackedEntityId: trackingType === "Serial" ? trackedEntityId : undefined
    }
  );

  if (issued.error) {
    if (sensorChanges.length > 0) {
      try {
        await getDatabaseClient()
          .transaction()
          .execute((trx) =>
            restoreSensorProduction(trx, { companyId, changes: sensorChanges })
          );
      } catch (err) {
        log.error("Failed to restore the sensor's Production after scrap", {
          companyId,
          jobOperationId,
          changes: sensorChanges,
          error: err
        });
      }
    }
    return data(
      {},
      await flash(
        request,
        error(issued.error, "Failed to record scrap quantity")
      )
    );
  }

  // The client (useOperation / AssemblyView) advances to the spawned
  // replacement serial the same way the complete flow does.
  return data(
    { scrapped: true, newTrackedEntityId: issued.data?.newTrackedEntityId },
    await flash(request, success("Scrap quantity recorded successfully"))
  );
}
