import { ValidatedForm } from "@carbon/form";
import {
  Button,
  HStack,
  ModalDrawer,
  ModalDrawerBody,
  ModalDrawerContent,
  ModalDrawerFooter,
  ModalDrawerHeader,
  ModalDrawerProvider,
  ModalDrawerTitle,
  toast,
  VStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { PostgrestResponse } from "@supabase/supabase-js";
import { useEffect } from "react";
import { useFetcher } from "react-router";
import type { z } from "zod";
import {
  CustomFormFields,
  Hidden,
  Input,
  Select,
  Submit
} from "~/components/Form";
import { usePermissions } from "~/hooks";
import { path } from "~/utils/path";
import {
  downtimeReasonValidator,
  downtimeTypes
} from "../../production.models";

type DowntimeReasonFormProps = {
  initialValues: z.infer<typeof downtimeReasonValidator>;
  type?: "modal" | "drawer";
  open?: boolean;
  onClose: () => void;
};

const DowntimeReasonForm = ({
  initialValues,
  open = true,
  type = "drawer",
  onClose
}: DowntimeReasonFormProps) => {
  const permissions = usePermissions();
  const { t } = useLingui();
  const fetcher = useFetcher<PostgrestResponse<{ id: string }>>();

  useEffect(() => {
    if (type !== "modal") return;

    if (fetcher.state === "loading" && fetcher.data?.data) {
      onClose?.();
      toast.success(t`Created downtime reason`);
    } else if (fetcher.state === "idle" && fetcher.data?.error) {
      toast.error(
        `Failed to create downtime reason: ${fetcher.data.error.message}`
      );
    }
  }, [fetcher.data, fetcher.state, onClose, type, t]);

  const isEditing = initialValues.id !== undefined;
  const isDisabled = isEditing
    ? !permissions.can("update", "production")
    : !permissions.can("create", "production");

  const typeOptions = downtimeTypes.map((value) => ({
    label: value,
    value
  }));

  return (
    <ModalDrawerProvider type={type}>
      <ModalDrawer
        open={open}
        onOpenChange={(open) => {
          if (!open) onClose?.();
        }}
      >
        <ModalDrawerContent>
          <ValidatedForm
            validator={downtimeReasonValidator}
            method="post"
            action={
              isEditing
                ? path.to.downtimeReason(initialValues.id!)
                : path.to.newDowntimeReason
            }
            defaultValues={initialValues}
            fetcher={fetcher}
            className="flex flex-col h-full"
          >
            <ModalDrawerHeader>
              <ModalDrawerTitle>
                {isEditing ? (
                  <Trans>Edit Downtime Reason</Trans>
                ) : (
                  <Trans>New Downtime Reason</Trans>
                )}
              </ModalDrawerTitle>
            </ModalDrawerHeader>
            {/*
              No <Hidden name="type"> modal marker here — it would collide
              with the reason's own `type` (Planned/Unplanned) field.
            */}
            <ModalDrawerBody>
              <Hidden name="id" />
              <VStack spacing={4}>
                <Input name="name" label={t`Downtime Reason`} />
                <Select
                  name="type"
                  label={t`Type`}
                  options={typeOptions}
                  helperText={t`Planned downtime (breaks, changeover) is excluded from availability; unplanned downtime counts against it`}
                />
                <CustomFormFields table="downtimeReason" />
              </VStack>
            </ModalDrawerBody>
            <ModalDrawerFooter>
              <HStack>
                <Submit isDisabled={isDisabled}>
                  <Trans>Save</Trans>
                </Submit>
                <Button size="md" variant="solid" onClick={() => onClose()}>
                  <Trans>Cancel</Trans>
                </Button>
              </HStack>
            </ModalDrawerFooter>
          </ValidatedForm>
        </ModalDrawerContent>
      </ModalDrawer>
    </ModalDrawerProvider>
  );
};

export default DowntimeReasonForm;
