import { error } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { Submit, ValidatedForm, validator } from "@carbon/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Heading,
  Label,
  ScrollArea,
  toast,
  VStack
} from "@carbon/react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { Combobox, Number as NumberField, Users } from "~/components/Form";
import { getDowntimeReasonsList } from "~/modules/production";
import {
  autoDowntimeValidator,
  getCompanySettings,
  jobCompletedValidator
} from "~/modules/settings";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Production`,
  to: path.to.productionSettings
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "settings"
  });

  const [companySettings, downtimeReasons] = await Promise.all([
    getCompanySettings(client, companyId),
    getDowntimeReasonsList(client, companyId)
  ]);

  if (!companySettings.data)
    throw redirect(
      path.to.settings,
      await flash(
        request,
        error(companySettings.error, "Failed to get company settings")
      )
    );
  return {
    companySettings: companySettings.data,
    downtimeReasons: downtimeReasons.data ?? []
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    update: "settings"
  });

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "jobCompleted") {
    const validation = await validator(jobCompletedValidator).validate(
      formData
    );

    if (validation.error) {
      return { success: false, message: "Invalid form data" };
    }

    const update = await client
      .from("companySettings")
      .update({
        inventoryJobCompletedNotificationGroup:
          validation.data.inventoryJobCompletedNotificationGroup ?? [],
        salesJobCompletedNotificationGroup:
          validation.data.salesJobCompletedNotificationGroup ?? []
      })
      .eq("id", companyId);

    if (update.error) return { success: false, message: update.error.message };

    return { success: true, message: "Job notification settings updated" };
  }

  if (intent === "autoDowntime") {
    const validation = await validator(autoDowntimeValidator).validate(
      formData
    );

    if (validation.error) {
      return { success: false, message: "Invalid form data" };
    }

    // Columns are newer than the generated DB types — cast until regen.
    // Empty multiplier/reason = feature off (NULL).
    const update = await (client as SupabaseClient<any>)
      .from("companySettings")
      .update({
        autoDowntimeMultiplier: validation.data.autoDowntimeMultiplier ?? null,
        autoDowntimeReasonId: validation.data.autoDowntimeReasonId || null
      })
      .eq("id", companyId);

    if (update.error) return { success: false, message: update.error.message };

    return { success: true, message: "Auto downtime settings updated" };
  }

  return { success: false, message: "Unknown intent" };
}

export default function ProductionSettingsRoute() {
  const { t } = useLingui();
  const { companySettings, downtimeReasons } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const autoDowntimeFetcher = useFetcher<typeof action>();

  const settingsWithAutoDowntime = companySettings as typeof companySettings & {
    autoDowntimeMultiplier: number | null;
    autoDowntimeReasonId: string | null;
  };
  const unplannedReasonOptions = downtimeReasons
    .filter((reason) => reason.type === "Unplanned")
    .map((reason) => ({ value: reason.id, label: reason.name }));

  useEffect(() => {
    if (fetcher.data?.success === true && fetcher?.data?.message) {
      toast.success(fetcher.data.message);
    }

    if (fetcher.data?.success === false && fetcher?.data?.message) {
      toast.error(fetcher.data.message);
    }
  }, [fetcher.data?.message, fetcher.data?.success]);

  useEffect(() => {
    if (
      autoDowntimeFetcher.data?.success === true &&
      autoDowntimeFetcher.data.message
    ) {
      toast.success(autoDowntimeFetcher.data.message);
    }

    if (
      autoDowntimeFetcher.data?.success === false &&
      autoDowntimeFetcher.data.message
    ) {
      toast.error(autoDowntimeFetcher.data.message);
    }
  }, [autoDowntimeFetcher.data?.message, autoDowntimeFetcher.data?.success]);

  return (
    <ScrollArea className="w-full h-[calc(100dvh-49px)]">
      <VStack
        spacing={4}
        className="py-12 px-4 max-w-[60rem] h-full mx-auto gap-4"
      >
        <Heading size="h3">
          <Trans>Production</Trans>
        </Heading>

        <Card>
          <ValidatedForm
            method="post"
            validator={jobCompletedValidator}
            defaultValues={{
              inventoryJobCompletedNotificationGroup:
                companySettings.inventoryJobCompletedNotificationGroup ?? [],
              salesJobCompletedNotificationGroup:
                companySettings.salesJobCompletedNotificationGroup ?? []
            }}
            fetcher={fetcher}
          >
            <input type="hidden" name="intent" value="jobCompleted" />
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trans>Completed Job Notifications</Trans>
              </CardTitle>
              <CardDescription>
                <Trans>
                  Configure notifications for when jobs are completed.
                </Trans>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-8 max-w-[400px]">
                <div className="flex flex-col gap-2">
                  <Label>
                    <Trans>Inventory Job Notifications</Trans>
                  </Label>
                  <Users
                    name="inventoryJobCompletedNotificationGroup"
                    label={t`Who should receive notifications when an inventory job is completed?`}
                    type="employee"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>
                    <Trans>Sales Job Notifications</Trans>
                  </Label>
                  <Users
                    name="salesJobCompletedNotificationGroup"
                    label={t`Who should receive notifications when a sales job is completed?`}
                    type="employee"
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Submit
                isDisabled={fetcher.state !== "idle"}
                isLoading={fetcher.state !== "idle"}
              >
                <Trans>Save</Trans>
              </Submit>
            </CardFooter>
          </ValidatedForm>
        </Card>

        <Card>
          <ValidatedForm
            method="post"
            validator={autoDowntimeValidator}
            defaultValues={{
              autoDowntimeMultiplier:
                settingsWithAutoDowntime.autoDowntimeMultiplier ?? undefined,
              autoDowntimeReasonId:
                settingsWithAutoDowntime.autoDowntimeReasonId ?? ""
            }}
            fetcher={autoDowntimeFetcher}
          >
            <input type="hidden" name="intent" value="autoDowntime" />
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trans>Automatic No-Output Downtime</Trans>
              </CardTitle>
              <CardDescription>
                <Trans>
                  When a work center has a running operation but no output is
                  logged within the multiplier × cycle time, it is automatically
                  flagged as unplanned downtime with the default reason. Leave
                  either field empty to disable. Work centers can override the
                  multiplier individually.
                </Trans>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-8 max-w-[400px]">
                <NumberField
                  name="autoDowntimeMultiplier"
                  label={t`Auto downtime after (× cycle time)`}
                  minValue={0}
                  helperText={t`e.g. 2 = flag after 2× the cycle time with no output`}
                />
                <Combobox
                  name="autoDowntimeReasonId"
                  label={t`Default downtime reason`}
                  options={unplannedReasonOptions}
                  placeholder={t`Select an unplanned downtime reason...`}
                  helperText={
                    unplannedReasonOptions.length === 0
                      ? t`No unplanned downtime reasons configured. Add them under Production → Downtime Reasons.`
                      : undefined
                  }
                />
              </div>
            </CardContent>
            <CardFooter>
              <Submit
                isDisabled={autoDowntimeFetcher.state !== "idle"}
                isLoading={autoDowntimeFetcher.state !== "idle"}
              >
                <Trans>Save</Trans>
              </Submit>
            </CardFooter>
          </ValidatedForm>
        </Card>
      </VStack>
    </ScrollArea>
  );
}
