// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// A quantity completed at an operation (`x+/complete.tsx`): the Log completed
// dialog of the operation view and the assembly view's completion. The route
// authenticates and passes its clients in.

import type { Permission } from "@carbon/auth";
import { error, success } from "@carbon/auth";
import { flash } from "@carbon/auth/session.server";
import type { Database } from "@carbon/database";
import { holdsGate } from "@carbon/database/access";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  lowerSensorProduction,
  restoreSensorProduction,
  type SensorProductionChange
} from "@carbon/database/machine-counts";
import { validationError, validator } from "@carbon/form";
import { getLogger } from "@carbon/logger";
import { EPSILON, redirect, round } from "@carbon/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import { data } from "react-router";
import type { erpPosting } from "~/services/erp";
import {
  completeQuantityValidator,
  scrapQuantityValidator
} from "~/services/models";
import {
  abilityBlockRefusal,
  finishJobOperation,
  getRequiredScanShortfall,
  getWorkCenterCountMode,
  insertProductionQuantity
} from "~/services/operations.service";
import { autoPrintOperationLabel } from "~/services/printing.server";
import { checkStrictBackflush } from "~/services/quality.server";
import {
  resolveWorkUnit,
  SELECT_UNIT_FIRST
} from "~/services/work-unit.server";
import { readOrigin, withOrigin } from "~/utils/origin";
import { path } from "~/utils/path";
import { insertProductionQuantityIfCurrent } from "./production-quantity.server";

const log = getLogger("mes");

const SENSOR_SHORTFALL =
  "The sensor has not counted that many pieces on this operation.";

class SensorShortfallError extends Error {}

export type CompleteDeps = {
  /** The caller's client. */
  client: SupabaseClient<Database>;
  serviceRole: SupabaseClient<Database>;
  db: () => Kysely<KyselyDatabase>;
  post: typeof erpPosting;
};

export async function completeOperationQuantity(
  deps: CompleteDeps,
  {
    request,
    companyId,
    userId,
    permissions
  }: {
    request: Request;
    companyId: string;
    userId: string;
    permissions: Record<string, Permission>;
  }
) {
  const { client, serviceRole } = deps;
  const formData = await request.formData();
  const validation = await validator(completeQuantityValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  // The page the operation was opened from; finishing returns there.
  const origin = readOrigin(formData);

  // Get current job operation and production quantities to check if operation will be finished
  const jobOperation = await serviceRole
    .from("jobOperation")
    .select("*")
    .eq("id", validation.data.jobOperationId)
    .eq("companyId", companyId)
    .maybeSingle();

  if (jobOperation.error || !jobOperation.data) {
    log.error("Job operation not found in company", {
      companyId,
      jobOperationId: validation.data.jobOperationId,
      error: jobOperation.error
    });
    return data(
      {},
      await flash(request, {
        ...error(jobOperation.error, "Failed to fetch job operation"),
        flash: "error"
      })
    );
  }

  // A serial completion names the unit the operator scanned or picked, open
  // here; the server never picks one for them (only the one left).
  const work = await resolveWorkUnit({
    client: serviceRole,
    companyId,
    operationId: jobOperation.data.id,
    requestedUnitId: validation.data.trackedEntityId,
    mode: "require"
  });
  if (work.kind === "refuse") {
    return data(
      {},
      await flash(request, { ...error(null, work.message), flash: "error" })
    );
  }
  // A serial Complete form describes the unit the operator was viewing. A
  // stale or empty selection must not silently complete its only eligible sibling.
  if (
    work.kind === "unit" &&
    work.via !== "named" &&
    validation.data.trackingType === "Serial"
  ) {
    return data(
      {},
      await flash(request, {
        ...error(null, SELECT_UNIT_FIRST),
        flash: "error"
      })
    );
  }
  const trackingType =
    work.kind === "unit"
      ? ("Serial" as const)
      : validation.data.trackingType === "Batch"
        ? ("Batch" as const)
        : undefined;
  const trackedEntityId =
    work.kind === "unit" ? work.unitId : validation.data.trackedEntityId;

  const refusal = await abilityBlockRefusal(serviceRole, {
    operationId: jobOperation.data.id,
    employeeId: userId,
    companyId
  });
  if (refusal) {
    return data(
      {},
      await flash(request, { ...error(null, refusal), flash: "error" })
    );
  }

  // A work center whose sensor counts (countMode Auto) logs completed
  // quantities itself; a manual count would count the pieces twice. A
  // supervisor may override with a note.
  if (jobOperation.data.workCenterId) {
    const countMode = await getWorkCenterCountMode(serviceRole, {
      workCenterId: jobOperation.data.workCenterId,
      companyId
    });
    if (countMode === "Auto") {
      const countRefusal = !validation.data.override
        ? "This work center logs completed quantities from its sensor."
        : !holdsGate(permissions, { "production.jobs": "Full" }, companyId) ||
            !validation.data.notes?.trim()
          ? "An override needs the supervisor permission and a note."
          : null;
      if (countRefusal) {
        return data(
          {},
          await flash(request, { ...error(null, countRefusal), flash: "error" })
        );
      }
    }
  }

  // The production event ids ride along into the productionQuantity row and
  // the issue call; RLS does not check a foreign key's tenant, so verify them.
  const productionEventIds = [
    validation.data.setupProductionEventId,
    validation.data.laborProductionEventId,
    validation.data.machineProductionEventId
  ].filter((id): id is string => Boolean(id));
  if (productionEventIds.length > 0) {
    const uniqueEventIds = [...new Set(productionEventIds)];
    const ownedEvents = await serviceRole
      .from("productionEvent")
      .select("id")
      .in("id", uniqueEventIds)
      .eq("companyId", companyId);
    if (
      ownedEvents.error ||
      (ownedEvents.data ?? []).length !== uniqueEventIds.length
    ) {
      log.error("Production event not found in company", {
        companyId,
        productionEventIds: uniqueEventIds,
        error: ownedEvents.error
      });
      return data(
        {},
        await flash(request, {
          ...error(ownedEvents.error, "Production event not found"),
          flash: "error"
        })
      );
    }
  }

  const shortfall = await getRequiredScanShortfall(serviceRole, {
    companyId,
    jobOperationId: jobOperation.data.id,
    trackedEntityId,
    parentIsSerial: trackingType === "Serial",
    quantity: validation.data.quantity
  });
  if (shortfall.message) {
    return data(
      {},
      await flash(request, {
        ...error(null, shortfall.message),
        flash: "error"
      })
    );
  }

  // Mirror the DB auto-Done predicate (sync_update_job_operation_quantities,
  // 20260807090629): scrap does NOT count toward targetQuantity — the op is
  // finished only once GOOD (+ reworked) quantity reaches the target.
  const totalAccountedQuantity =
    (jobOperation.data.quantityComplete ?? 0) +
    (jobOperation.data.quantityReworked ?? 0) +
    validation.data.quantity;

  const willBeFinished =
    totalAccountedQuantity >=
    (jobOperation.data.targetQuantity ??
      jobOperation.data.operationQuantity ??
      0);

  if (trackingType === "Serial") {
    const response = await deps.post(
      "issue",
      { companyId, userId },
      {
        type: "jobOperationSerialComplete",
        ...validation.data,
        trackedEntityId: trackedEntityId!
      }
    );

    const newTrackedEntityId = response.data?.newTrackedEntityId as
      | string
      | undefined;
    if (response.error) {
      return data(
        {},
        await flash(request, {
          ...error(
            response.error,
            response.error.message || "Failed to complete job operation"
          ),
          flash: "error"
        })
      );
    }

    // Print the entity that was just completed, not the new reserved one
    const completedEntityId = trackedEntityId;

    // Auto-print the unit label at the first or last operation (autoPrintOperationLabel decides)
    const printEntityId = completedEntityId || newTrackedEntityId;
    if (printEntityId) {
      await autoPrintOperationLabel({
        serviceRole,
        trackedEntityId: printEntityId,
        jobOperationId: jobOperation.data.id,
        jobMakeMethodId: jobOperation.data.jobMakeMethodId,
        workCenterId: jobOperation.data.workCenterId ?? undefined,
        companyId,
        userId
      });
    }

    if (willBeFinished) {
      const finishOperation = await finishJobOperation(serviceRole, {
        jobOperationId: jobOperation.data.id,
        userId,
        companyId
      });

      if (finishOperation.error) {
        return data(
          {},
          await flash(request, {
            ...error(finishOperation.error, "Failed to finish operation"),
            flash: "error"
          })
        );
      }

      return redirect(
        origin ?? path.to.operations,
        await flash(request, {
          ...success("Operation finished successfully"),
          flash: "success"
        })
      );
    }

    // Not finished: complete this unit and let the client (useOperation for the
    // operation view, AssemblyView for assembly ops) decide how to advance —
    // auto-select the next unit on the first operation, or open the scan/select
    // picker on later operations. Returning data (instead of redirecting to a
    // specific next unit) keeps the just-completed unit in the URL and revalidates
    // the loader, so the client is the single advancement authority and nothing
    // races it. The `{ completed: true }` marker lets AssemblyView tell a
    // successful completion apart from a failure (which returns an empty `{}`).
    return data(
      { completed: true },
      await flash(request, {
        ...success("Completed"),
        flash: "success"
      })
    );
  } else if (trackingType === "Batch") {
    const response = await deps.post(
      "issue",
      { companyId, userId },
      {
        type: "jobOperationBatchComplete",
        ...validation.data,
        trackedEntityId: validation.data.trackedEntityId!
      }
    );

    if (response.error) {
      return data(
        {},
        await flash(request, {
          ...error(
            response.error,
            response.error.message || "Failed to complete job operation"
          ),
          flash: "error"
        })
      );
    }

    // Auto-print the unit label at the first or last operation (autoPrintOperationLabel decides)
    if (validation.data.trackedEntityId) {
      await autoPrintOperationLabel({
        serviceRole,
        trackedEntityId: validation.data.trackedEntityId,
        jobOperationId: jobOperation.data.id,
        jobMakeMethodId: jobOperation.data.jobMakeMethodId,
        workCenterId: jobOperation.data.workCenterId ?? undefined,
        companyId,
        userId
      });
    }

    if (willBeFinished) {
      const finishOperation = await finishJobOperation(serviceRole, {
        jobOperationId: jobOperation.data.id,
        userId,
        companyId
      });

      if (finishOperation.error) {
        return data(
          {},
          await flash(request, {
            ...error(finishOperation.error, "Failed to finish operation"),
            flash: "error"
          })
        );
      }

      return redirect(
        origin ?? path.to.operations,
        await flash(request, {
          ...success("Operation finished successfully"),
          flash: "success"
        })
      );
    }

    const operationPath = path.to.operation(validation.data.jobOperationId);
    return redirect(withOrigin(operationPath, origin));
  } else {
    const {
      trackedEntityId: _unit,
      trackingType: _trackingType,
      expectedQuantityComplete,
      // Not a productionQuantity column.
      override: _override,
      ...d
    } = validation.data;

    const check = await checkStrictBackflush({
      jobOperationId: validation.data.jobOperationId,
      quantity: validation.data.quantity,
      companyId,
      userId
    });

    if (check.error) {
      return data(
        {},
        await flash(request, {
          ...error(check.error, check.message!),
          flash: "error"
        })
      );
    }

    let recorded: unknown;
    if (expectedQuantityComplete !== undefined) {
      // The page sent the completed quantity it showed: record the unit only
      // if no other request (a second tab, a resend) recorded it meanwhile.
      if (!holdsGate(permissions, { "production.jobs": "Create" }, companyId)) {
        return data(
          {},
          await flash(request, {
            ...error(null, "You do not have permission to record production"),
            flash: "error"
          })
        );
      }
      let inserted: { id: string } | null;
      try {
        inserted = await insertProductionQuantityIfCurrent(
          deps.db(),
          { ...d, companyId, createdBy: userId },
          expectedQuantityComplete
        );
      } catch (err) {
        log.error("Failed to record production quantity", {
          companyId,
          jobOperationId: jobOperation.data.id,
          error: err
        });
        return data(
          {},
          await flash(request, {
            ...error(err, "Failed to record production quantity"),
            flash: "error"
          })
        );
      }
      if (!inserted) {
        log.info("Completion skipped: the unit is already recorded", {
          companyId,
          jobOperationId: jobOperation.data.id,
          expectedQuantityComplete
        });
        return data({ alreadyRecorded: true });
      }
      recorded = [inserted];
    } else {
      const insertProduction = await insertProductionQuantity(client, {
        ...d,
        companyId,
        createdBy: userId
      });

      if (insertProduction.error) {
        return data(
          {},
          await flash(request, {
            ...error(
              insertProduction.error,
              "Failed to record production quantity"
            ),
            flash: "error"
          })
        );
      }
      recorded = insertProduction.data;
    }

    const issued = await deps.post(
      "issue",
      { companyId, userId },
      {
        id: validation.data.jobOperationId,
        type: "jobOperation",
        quantity: validation.data.quantity
      }
    );

    if (issued.error) {
      return data(
        {},
        await flash(request, {
          ...error(
            issued.error,
            `Units completed, but ${issued.error.message || "failed to issue materials"}`
          ),
          flash: "error"
        })
      );
    }

    if (willBeFinished) {
      const finishOperation = await finishJobOperation(serviceRole, {
        jobOperationId: jobOperation.data.id,
        userId,
        companyId
      });

      if (finishOperation.error) {
        return data(
          {},
          await flash(request, {
            ...error(finishOperation.error, "Failed to finish operation"),
            flash: "error"
          })
        );
      }

      return redirect(
        origin ?? path.to.operations,
        await flash(request, {
          ...success("Operation finished successfully"),
          flash: "success"
        })
      );
    }

    return data(
      recorded,
      await flash(request, {
        ...success("Successfully completed part"),
        flash: "success"
      })
    );
  }
}

/** A scrap quantity at an operation (`x+/scrap.tsx`). The route authenticates. */
export async function scrapOperationQuantity(
  deps: {
    client: SupabaseClient<Database>;
    db: () => Kysely<KyselyDatabase>;
    post: typeof erpPosting;
  },
  {
    request,
    companyId,
    userId
  }: { request: Request; companyId: string; userId: string }
) {
  const formData = await request.formData();
  const validation = await validator(scrapQuantityValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const {
    trackedEntityId,
    jobOperationId,
    quantity,
    scrapReasonId,
    notes,
    countedBySensor,
    setupProductionEventId,
    laborProductionEventId,
    machineProductionEventId
  } = validation.data;

  const serviceRole = deps.client;
  // A serial scrap names the unit the operator scanned or picked, open here.
  const work = await resolveWorkUnit({
    client: serviceRole,
    companyId,
    operationId: jobOperationId,
    requestedUnitId: trackedEntityId,
    mode: "require"
  });
  if (work.kind === "refuse") {
    return data({}, await flash(request, error(null, work.message)));
  }

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
  if (countedBySensor && work.kind !== "unit") {
    try {
      sensorChanges = await deps
        .db()
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
  const issued = await deps.post(
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
      trackedEntityId: work.kind === "unit" ? work.unitId : undefined
    }
  );

  if (issued.error) {
    if (sensorChanges.length > 0) {
      try {
        await deps
          .db()
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
