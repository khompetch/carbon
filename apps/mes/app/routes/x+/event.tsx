import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import { getLocalTimeZone, now } from "@internationalized/date";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { productionEventValidator } from "~/services/models";
import {
  endProductionEvent,
  getMissingOperationRequirements,
  startProductionEvent
} from "~/services/operations.service";

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {});

  const formData = await request.formData();
  const validation = await validator(productionEventValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const {
    id,
    action: productionAction,
    timezone,
    trackedEntityId,
    ...d
  } = validation.data;

  if (productionAction === "Start") {
    const serviceRole = await getCarbonServiceRole();
    // Resolve the work center and process from the operation server-side
    // rather than trusting the submitted workCenterId.
    const jobOperation = await serviceRole
      .from("jobOperation")
      .select("workCenterId, processId")
      .eq("id", d.jobOperationId)
      .eq("companyId", companyId)
      .maybeSingle();

    const missing = await getMissingOperationRequirements(serviceRole, {
      workCenterId: jobOperation.data?.workCenterId,
      processId: jobOperation.data?.processId,
      employeeId: userId,
      companyId
    });

    if (missing.abilityNames.length > 0 || missing.trainingNames.length > 0) {
      const requirements = [
        ...missing.abilityNames.map((name) => `ability: ${name}`),
        ...missing.trainingNames.map((name) => `training: ${name}`)
      ].join(", ");
      return data(
        {},
        await flash(
          request,
          error(
            `You have not completed the requirements for this operation (${requirements})`,
            "Cannot start operation"
          )
        )
      );
    }

    const startEvent = await startProductionEvent(
      client,
      {
        ...d,
        startTime: now(timezone ?? getLocalTimeZone()).toAbsoluteString(),
        employeeId: userId,
        companyId,
        createdBy: userId
      },
      trackedEntityId
    );

    if (startEvent.error) {
      return data(
        {},
        await flash(request, error(startEvent.error, "Failed to start event"))
      );
    }

    return data(
      startEvent.data,
      await flash(request, success(`Started ${d.type.toLowerCase()} operation`))
    );
  } else {
    if (!id) {
      return data({}, await flash(request, error("No event id provided")));
    }
    const endEvent = await endProductionEvent(client, {
      id,
      endTime: now(timezone ?? getLocalTimeZone()).toAbsoluteString(),
      employeeId: userId
    });
    if (endEvent.error) {
      return data(
        {},
        await flash(request, error(endEvent.error, "Failed to end event"))
      );
    }
    if (endEvent.data && endEvent.data.length > 0) {
      const serviceRole = await getCarbonServiceRole();
      await serviceRole.functions.invoke("post-production-event", {
        body: {
          productionEventId: endEvent.data[0].id,
          userId,
          companyId
        }
      });
    }
    return data(
      endEvent.data,
      await flash(request, success(`Ended ${d.type.toLowerCase()} operation`))
    );
  }
}
