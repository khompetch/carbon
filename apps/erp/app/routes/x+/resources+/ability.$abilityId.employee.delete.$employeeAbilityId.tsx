import { error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { useLingui } from "@lingui/react/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useParams } from "react-router";
import { ConfirmDelete } from "~/components/Modals";
import { deleteEmployeeAbility, getEmployeeAbility } from "~/modules/resources";
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
  const { client } = await requirePermissions(request, {
    update: "resources"
  });

  const { abilityId, employeeAbilityId } = params;
  if (!abilityId) throw notFound("abilityId not found");
  if (!employeeAbilityId) {
    throw redirect(
      path.to.abilities,
      await flash(
        request,
        error(params, "Failed to get an employee ability id")
      )
    );
  }

  // Soft delete (active: false) — preserves training history and lets
  // upsertEmployeeAbility reactivate the row if the employee is re-added.
  const { error: deleteError } = await deleteEmployeeAbility(
    client,
    employeeAbilityId
  );
  if (deleteError) {
    throw redirect(
      path.to.ability(abilityId),
      await flash(request, error(deleteError, "Failed to remove employee"))
    );
  }

  throw redirect(
    path.to.ability(abilityId),
    await flash(request, success("Removed employee from ability"))
  );
}

export default function DeleteEmployeeAbilityRoute() {
  const { abilityId, employeeAbilityId } = useParams();
  const { employeeAbility } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useLingui();

  if (!employeeAbility) return null;
  if (!abilityId) throw notFound("abilityId not found");
  if (!employeeAbilityId) throw notFound("employeeAbilityId not found");

  const onCancel = () => navigate(path.to.ability(abilityId));
  return (
    <ConfirmDelete
      action={path.to.deleteEmployeeAbility(abilityId, employeeAbilityId)}
      name={t`employee ability`}
      text={t`Are you sure you want to remove this employee from the ability?`}
      onCancel={onCancel}
    />
  );
}
