import { assertIsPost, error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useParams } from "react-router";
import {
  employeeAbilityValidator,
  getEmployeeAbility,
  upsertEmployeeAbility
} from "~/modules/resources";
import {
  AbilityEmployeeStatus,
  getTrainingStatus
} from "~/modules/resources/types";
import EmployeeAbilityForm from "~/modules/resources/ui/Abilities/EmployeeAbilityForm";
import { path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client } = await requirePermissions(request, {
    view: "resources",
    role: "employee"
  });

  const { abilityId, employeeAbilityId } = params;
  if (!abilityId) throw notFound("abilityId not found");
  if (!employeeAbilityId) throw notFound("employeeAbilityId not found");

  const employeeAbility = await getEmployeeAbility(client, employeeAbilityId);
  if (employeeAbility.error || !employeeAbility.data) {
    throw redirect(
      path.to.ability(abilityId),
      await flash(
        request,
        error(employeeAbility.error, "Failed to get employee ability")
      )
    );
  }

  return { employeeAbility: employeeAbility.data };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId } = await requirePermissions(request, {
    update: "resources"
  });

  const { abilityId, employeeAbilityId } = params;
  if (!abilityId) throw notFound("abilityId not found");
  if (!employeeAbilityId) throw notFound("employeeAbilityId not found");

  const formData = await request.formData();
  const validation = await validator(employeeAbilityValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { employeeId, trainingStatus, trainingDays } = validation.data;

  const upsert = await upsertEmployeeAbility(client, {
    id: employeeAbilityId,
    abilityId,
    employeeId,
    companyId,
    trainingCompleted: trainingStatus === AbilityEmployeeStatus.Complete,
    trainingDays:
      trainingStatus === AbilityEmployeeStatus.InProgress
        ? (trainingDays ?? 0)
        : 0
  });
  if (upsert.error) {
    throw redirect(
      path.to.ability(abilityId),
      await flash(
        request,
        error(upsert.error, "Failed to update employee ability")
      )
    );
  }

  throw redirect(
    path.to.ability(abilityId),
    await flash(request, success("Employee ability updated"))
  );
}

export default function EmployeeAbilityRoute() {
  const { employeeAbility } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { abilityId, employeeAbilityId } = useParams();
  if (!abilityId) throw new Error("abilityId not found");

  const initialValues = {
    employeeId: employeeAbility.employeeId,
    trainingStatus: (getTrainingStatus(employeeAbility) ??
      AbilityEmployeeStatus.NotStarted) as string,
    trainingDays: employeeAbility.trainingDays
  };

  return (
    <EmployeeAbilityForm
      abilityId={abilityId}
      employeeAbilityId={employeeAbilityId}
      initialValues={initialValues}
      onClose={() => navigate(path.to.ability(abilityId))}
    />
  );
}
