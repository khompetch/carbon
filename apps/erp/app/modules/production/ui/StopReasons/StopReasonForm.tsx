// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

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
import { stopReasonValidator } from "../../production.models";
import { useOeeLossLabel } from "./useOeeLossLabel";

type StopReasonFormProps = {
  initialValues: Omit<z.infer<typeof stopReasonValidator>, "oeeLoss"> & {
    oeeLoss?: z.infer<typeof stopReasonValidator>["oeeLoss"];
  };
  type?: "modal" | "drawer";
  open?: boolean;
  onClose: () => void;
};

const StopReasonForm = ({
  initialValues,
  open = true,
  type = "drawer",
  onClose
}: StopReasonFormProps) => {
  const permissions = usePermissions();
  const { t } = useLingui();
  const fetcher = useFetcher<PostgrestResponse<{ id: string }>>();
  const { options: oeeLossOptions } = useOeeLossLabel();

  useEffect(() => {
    if (type !== "modal") return;

    if (fetcher.state === "loading" && fetcher.data?.data) {
      onClose?.();
      toast.success(t`Created stop reason`);
    } else if (fetcher.state === "idle" && fetcher.data?.error) {
      toast.error(
        t`Failed to create stop reason: ${fetcher.data.error.message}`
      );
    }
  }, [fetcher.data, fetcher.state, onClose, type, t]);

  const isEditing = initialValues.id !== undefined;
  const isDisabled = isEditing
    ? !permissions.has({ "production.stopReasons": "Edit" })
    : !permissions.has({ "production.stopReasons": "Create" });

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
            validator={stopReasonValidator}
            method="post"
            action={
              isEditing
                ? path.to.stopReason(initialValues.id!)
                : path.to.newStopReason
            }
            defaultValues={initialValues}
            fetcher={fetcher}
            className="flex flex-col h-full"
          >
            <ModalDrawerHeader>
              <ModalDrawerTitle>
                {isEditing ? t`Edit Stop Reason` : t`New Stop Reason`}
              </ModalDrawerTitle>
            </ModalDrawerHeader>
            <ModalDrawerBody>
              <Hidden name="id" />
              <Hidden name="type" value={type} />
              <VStack spacing={4}>
                <Input name="name" label={t`Stop Reason`} />
                <Select
                  name="oeeLoss"
                  label={t`Loss`}
                  options={oeeLossOptions}
                />
                <CustomFormFields table="stopReason" />
              </VStack>
            </ModalDrawerBody>
            <ModalDrawerFooter>
              <HStack>
                <Submit hideShortcutKey isDisabled={isDisabled}>
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

export default StopReasonForm;
