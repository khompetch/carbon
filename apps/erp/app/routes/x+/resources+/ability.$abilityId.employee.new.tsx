import { assertIsPost, error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useNavigate, useParams } from "react-router";
import {
  employeeAbilityValidator,
  upsertEmployeeAbility
} from "~/modules/resources";
import { AbilityEmployeeStatus } from "~/modules/resources/types";
import EmployeeAbilityForm from "~/modules/resources/ui/Abilities/EmployeeAbilityForm";
import { path } from "~/utils/path";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermissions(request, {
    update: "resources"
  });

  return null;
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId } = await requirePermissions(request, {
    update: "resources"
  });

  const { abilityId } = params;
  if (!abilityId) throw notFound("abilityId not found");

  const formData = await request.formData();
  const validation = await validator(employeeAbilityValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { employeeId, trainingStatus, trainingDays } = validation.data;

  const upsert = await upsertEmployeeAbility(client, {
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
      await flash(request, error(upsert.error, "Failed to add employee"))
    );
  }

  throw redirect(
    path.to.ability(abilityId),
    await flash(request, success("Employee added to ability"))
  );
}

export default function NewEmployeeAbilityRoute() {
  const navigate = useNavigate();
  const { abilityId } = useParams();
  if (!abilityId) throw new Error("abilityId not found");

  const initialValues = {
    employeeId: "",
    trainingStatus: AbilityEmployeeStatus.Complete as string,
    trainingDays: 0
  };

  return (
    <EmployeeAbilityForm
      abilityId={abilityId}
      initialValues={initialValues}
      onClose={() => navigate(path.to.ability(abilityId))}
    />
  );
}
