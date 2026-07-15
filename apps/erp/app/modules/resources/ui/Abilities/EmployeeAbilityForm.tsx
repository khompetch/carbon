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
  VStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useFetcher } from "react-router";
import type { z } from "zod";
import { Employee, Number, Select, Submit } from "~/components/Form";
import { usePermissions } from "~/hooks";
import { path } from "~/utils/path";
import { employeeAbilityValidator } from "../../resources.models";
import { AbilityEmployeeStatus } from "../../types";

type EmployeeAbilityFormProps = {
  abilityId: string;
  employeeAbilityId?: string;
  initialValues: z.infer<typeof employeeAbilityValidator>;
  onClose: () => void;
};

const EmployeeAbilityForm = ({
  abilityId,
  employeeAbilityId,
  initialValues,
  onClose
}: EmployeeAbilityFormProps) => {
  const { t } = useLingui();
  const permissions = usePermissions();
  const fetcher = useFetcher<{}>();

  const isEditing = employeeAbilityId !== undefined;
  const isDisabled = isEditing
    ? !permissions.can("update", "resources")
    : !permissions.can("create", "resources");

  const [trainingStatus, setTrainingStatus] = useState(
    initialValues.trainingStatus
  );

  const statusOptions = Object.values(AbilityEmployeeStatus).map((status) => ({
    value: status,
    label: status
  }));

  return (
    <ModalDrawerProvider type="drawer">
      <ModalDrawer
        open
        onOpenChange={(open) => {
          if (!open) onClose?.();
        }}
      >
        <ModalDrawerContent>
          <ValidatedForm
            validator={employeeAbilityValidator}
            method="post"
            action={
              isEditing
                ? path.to.employeeAbility(abilityId, employeeAbilityId)
                : path.to.newEmployeeAbility(abilityId)
            }
            defaultValues={initialValues}
            fetcher={fetcher}
            className="flex flex-col h-full"
          >
            <ModalDrawerHeader>
              <ModalDrawerTitle>
                {isEditing ? (
                  <Trans>Edit Employee Ability</Trans>
                ) : (
                  <Trans>Add Employee</Trans>
                )}
              </ModalDrawerTitle>
            </ModalDrawerHeader>
            <ModalDrawerBody>
              <VStack spacing={4}>
                <Employee
                  name="employeeId"
                  label={t`Employee`}
                  isReadOnly={isEditing}
                />
                <Select
                  name="trainingStatus"
                  label={t`Training Status`}
                  options={statusOptions}
                  onChange={(option) => {
                    if (option) setTrainingStatus(option.value);
                  }}
                />
                {trainingStatus === AbilityEmployeeStatus.InProgress && (
                  <Number
                    name="trainingDays"
                    label={t`Days of Training Completed`}
                    minValue={0}
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

export default EmployeeAbilityForm;
