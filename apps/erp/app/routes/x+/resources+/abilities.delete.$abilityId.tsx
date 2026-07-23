import { error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { useLingui } from "@lingui/react/macro";
import type {
  ActionFunctionArgs,
  ClientActionFunctionArgs,
  LoaderFunctionArgs
} from "react-router";
import { redirect, useLoaderData, useNavigate, useParams } from "react-router";
import { ConfirmDelete } from "~/components/Modals";
import { deleteAbility, getAbility } from "~/modules/resources";
import { getParams, path } from "~/utils/path";
import { abilitiesQuery, getCompanyId } from "~/utils/react-query";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client } = await requirePermissions(request, {
    view: "resources",
    role: "employee"
  });
  const { abilityId } = params;
  if (!abilityId) throw notFound("abilityId not found");

  const ability = await getAbility(client, abilityId);
  if (ability.error) {
    throw redirect(
      `${path.to.abilities}?${getParams(request)}`,
      await flash(request, error(ability.error, "Failed to get ability"))
    );
  }

  return { ability: ability.data };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { client } = await requirePermissions(request, {
    delete: "resources"
  });

  const { abilityId } = params;
  if (!abilityId) {
    throw redirect(
      `${path.to.abilities}?${getParams(request)}`,
      await flash(request, error(params, "Failed to get an ability id"))
    );
  }

  // Soft delete — abilities may be referenced by employeeAbility history and
  // workCenter.requiredAbilityId.
  const { error: deleteAbilityError } = await deleteAbility(
    client,
    abilityId,
    false
  );
  if (deleteAbilityError) {
    throw redirect(
      `${path.to.abilities}?${getParams(request)}`,
      await flash(
        request,
        error(deleteAbilityError, "Failed to delete ability")
      )
    );
  }

  throw redirect(
    `${path.to.abilities}?${getParams(request)}`,
    await flash(request, success("Successfully deleted ability"))
  );
}

export async function clientAction({ serverAction }: ClientActionFunctionArgs) {
  window.clientCache?.setQueryData(
    abilitiesQuery(getCompanyId()).queryKey,
    null
  );
  return await serverAction();
}

export default function DeleteAbilityRoute() {
  const { abilityId } = useParams();
  const { ability } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useLingui();

  if (!ability) return null;
  if (!abilityId) throw notFound("abilityId not found");

  const onCancel = () => navigate(path.to.abilities);
  const name = ability.name;
  return (
    <ConfirmDelete
      action={path.to.deleteAbility(abilityId)}
      name={name}
      text={t`Are you sure you want to delete the ability: ${name}? This cannot be undone.`}
      onCancel={onCancel}
    />
  );
}
