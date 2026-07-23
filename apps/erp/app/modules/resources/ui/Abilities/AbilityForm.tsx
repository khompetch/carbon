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
import { Employees, Hidden, Input, Number, Submit } from "~/components/Form";
import { usePermissions } from "~/hooks";
import { path } from "~/utils/path";
import { abilityValidator } from "../../resources.models";

type AbilityFormProps = {
  initialValues: z.infer<typeof abilityValidator>;
  type?: "modal" | "drawer";
  open?: boolean;
  onClose: () => void;
};

const AbilityForm = ({
  initialValues,
  open = true,
  type = "drawer",
  onClose
}: AbilityFormProps) => {
  const { t } = useLingui();
  const permissions = usePermissions();
  const fetcher = useFetcher<PostgrestResponse<{ id: string }>>();

  useEffect(() => {
    if (type !== "modal") return;

    if (fetcher.state === "loading" && fetcher.data?.data) {
      onClose?.();
      toast.success(t`Created ability`);
    } else if (fetcher.state === "idle" && fetcher.data?.error) {
      toast.error(t`Failed to create ability: ${fetcher.data.error.message}`);
    }
  }, [fetcher.data, fetcher.state, onClose, type, t]);

  const isEditing = initialValues.id !== undefined;
  const isDisabled = isEditing
    ? !permissions.can("update", "resources")
    : !permissions.can("create", "resources");

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
            validator={abilityValidator}
            method="post"
            action={
              isEditing
                ? path.to.ability(initialValues.id!)
                : path.to.newAbility
            }
            defaultValues={initialValues}
            fetcher={fetcher}
            className="flex flex-col h-full"
          >
            <ModalDrawerHeader>
              <ModalDrawerTitle>
                {isEditing ? (
                  <Trans>Edit Ability</Trans>
                ) : (
                  <Trans>New Ability</Trans>
                )}
              </ModalDrawerTitle>
            </ModalDrawerHeader>
            <ModalDrawerBody>
              <Hidden name="id" />
              <Hidden name="formType" value={type} />
              <VStack spacing={4}>
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
                {!isEditing && (
                  <Employees
                    name="employees"
                    label={t`Employees with this ability`}
                  />
                )}
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

export default AbilityForm;
