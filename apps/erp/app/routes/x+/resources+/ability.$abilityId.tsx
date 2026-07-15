import { assertIsPost, error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { ValidatedForm, validationError, validator } from "@carbon/form";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  HStack,
  VStack
} from "@carbon/react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData } from "react-router";
import { Hidden, Input, Number, Submit } from "~/components/Form";
import { usePermissions } from "~/hooks";
import {
  abilityValidator,
  getAbility,
  makeAbilityCurve,
  updateAbility
} from "~/modules/resources";
import AbilityEmployeesTable from "~/modules/resources/ui/Abilities/AbilityEmployeesTable";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Abilities`,
  to: path.to.abilities,
  module: "resources"
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client } = await requirePermissions(request, {
    view: "resources",
    role: "employee"
  });

  const { abilityId } = params;
  if (!abilityId) throw notFound("abilityId not found");

  const ability = await getAbility(client, abilityId);
  if (ability.error || !ability.data) {
    throw redirect(
      path.to.abilities,
      await flash(request, error(ability.error, "Failed to get ability"))
    );
  }

  return { ability: ability.data };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client } = await requirePermissions(request, {
    update: "resources"
  });

  const { abilityId } = params;
  if (!abilityId) throw notFound("abilityId not found");

  const formData = await request.formData();
  const validation = await validator(abilityValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const { name, startingPoint, weeks, shadowWeeks } = validation.data;

  const update = await updateAbility(client, abilityId, {
    name,
    curve: makeAbilityCurve(startingPoint, weeks),
    shadowWeeks
  });
  if (update.error) {
    throw redirect(
      path.to.ability(abilityId),
      await flash(request, error(update.error, "Failed to update ability"))
    );
  }

  throw redirect(
    path.to.ability(abilityId),
    await flash(request, success("Ability updated"))
  );
}

export default function AbilityRoute() {
  const { ability } = useLoaderData<typeof loader>();
  const { t } = useLingui();
  const permissions = usePermissions();

  const curve = ability.curve as {
    data: { week: number; value: number }[];
  } | null;
  const curveData = curve?.data ?? [];

  const initialValues = {
    id: ability.id,
    name: ability.name,
    startingPoint: curveData[0]?.value ?? 85,
    weeks: curveData[curveData.length - 1]?.week ?? 4,
    shadowWeeks: ability.shadowWeeks
  };

  return (
    <VStack
      spacing={4}
      className="p-4 h-full overflow-y-auto scrollbar-thin scrollbar-thumb-rounded-full scrollbar-thumb-muted-foreground"
    >
      <Card>
        <CardHeader>
          <CardTitle>{ability.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <ValidatedForm
            validator={abilityValidator}
            method="post"
            action={path.to.ability(ability.id)}
            defaultValues={initialValues}
          >
            <Hidden name="id" />
            <VStack spacing={4} className="max-w-md">
              <Input name="name" label={t`Name`} />
              <Number
                name="startingPoint"
                label={t`Starting Efficiency (%)`}
                helperText={t`Efficiency of an untrained employee at week 0`}
                minValue={0}
                maxValue={100}
              />
              <Number
                name="weeks"
                label={t`Weeks to Full Efficiency`}
                minValue={0}
              />
              <Number
                name="shadowWeeks"
                label={t`Shadow Weeks`}
                helperText={t`Weeks spent shadowing another employee before working independently`}
                minValue={0}
              />
              <HStack>
                <Submit isDisabled={!permissions.can("update", "resources")}>
                  <Trans>Save</Trans>
                </Submit>
              </HStack>
            </VStack>
          </ValidatedForm>
        </CardContent>
      </Card>

      <AbilityEmployeesTable
        abilityId={ability.id}
        employees={ability.employeeAbility ?? []}
      />
      <Outlet />
    </VStack>
  );
}
