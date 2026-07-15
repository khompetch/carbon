import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useNavigate } from "react-router";
import {
  abilityValidator,
  insertAbility,
  insertEmployeeAbilities,
  makeAbilityCurve
} from "~/modules/resources";
import AbilityForm from "~/modules/resources/ui/Abilities/AbilityForm";
import { getParams, path, requestReferrer } from "~/utils/path";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermissions(request, {
    create: "resources"
  });

  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    create: "resources"
  });

  const formData = await request.formData();
  const modal = formData.get("formType") === "modal";

  const validation = await validator(abilityValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const { name, startingPoint, weeks, shadowWeeks, employees } =
    validation.data;

  const createAbility = await insertAbility(client, {
    name,
    curve: makeAbilityCurve(startingPoint, weeks),
    shadowWeeks,
    companyId,
    createdBy: userId
  });
  if (createAbility.error) {
    return modal
      ? createAbility
      : redirect(
          requestReferrer(request) ??
            `${path.to.abilities}?${getParams(request)}`,
          await flash(
            request,
            error(createAbility.error, "Failed to create ability")
          )
        );
  }

  if (employees?.length && createAbility.data?.id) {
    const createEmployeeAbilities = await insertEmployeeAbilities(
      client,
      createAbility.data.id,
      employees,
      companyId
    );
    if (createEmployeeAbilities.error) {
      return modal
        ? createEmployeeAbilities
        : redirect(
            `${path.to.abilities}?${getParams(request)}`,
            await flash(
              request,
              error(
                createEmployeeAbilities.error,
                "Ability created, but failed to add employees"
              )
            )
          );
    }
  }

  return modal
    ? createAbility
    : redirect(
        `${path.to.abilities}?${getParams(request)}`,
        await flash(request, success("Ability created"))
      );
}

export default function NewAbilityRoute() {
  const navigate = useNavigate();
  const initialValues = {
    name: "",
    startingPoint: 85,
    weeks: 4,
    shadowWeeks: 0,
    employees: []
  };

  return (
    <AbilityForm initialValues={initialValues} onClose={() => navigate(-1)} />
  );
}
