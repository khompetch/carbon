import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { LuEllipsisVertical, LuPencil, LuPlus, LuTrash } from "react-icons/lu";
import { useNavigate } from "react-router";
import { EmployeeAvatar } from "~/components";
import { useDateFormatter, usePermissions } from "~/hooks";
import { path } from "~/utils/path";
import type { AbilityEmployees } from "../../types";
import { AbilityEmployeeStatus, getTrainingStatus } from "../../types";

type AbilityEmployeesTableProps = {
  abilityId: string;
  employees: AbilityEmployees;
};

const statusVariant: Record<AbilityEmployeeStatus, "green" | "blue" | "gray"> =
  {
    [AbilityEmployeeStatus.Complete]: "green",
    [AbilityEmployeeStatus.InProgress]: "blue",
    [AbilityEmployeeStatus.NotStarted]: "gray"
  };

const AbilityEmployeesTable = ({
  abilityId,
  employees
}: AbilityEmployeesTableProps) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const permissions = usePermissions();
  const { formatDate } = useDateFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Trans>Employees</Trans>
        </CardTitle>
        <CardAction>
          {permissions.can("update", "resources") && (
            <Button
              leftIcon={<LuPlus />}
              onClick={() => navigate(path.to.newEmployeeAbility(abilityId))}
            >
              <Trans>Add Employee</Trans>
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {employees.length === 0 ? (
          <div className="text-muted-foreground text-center p-4 w-full">
            <Trans>No employees have this ability</Trans>
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>
                  <Trans>Employee</Trans>
                </Th>
                <Th>
                  <Trans>Status</Trans>
                </Th>
                <Th>
                  <Trans>Training Days</Trans>
                </Th>
                <Th>
                  <Trans>Last Training</Trans>
                </Th>
                <Th className="w-[50px]" />
              </Tr>
            </Thead>
            <Tbody>
              {employees.map((employeeAbility) => {
                const status =
                  getTrainingStatus(employeeAbility) ??
                  AbilityEmployeeStatus.NotStarted;
                return (
                  <Tr key={employeeAbility.id}>
                    <Td>
                      <EmployeeAvatar employeeId={employeeAbility.employeeId} />
                    </Td>
                    <Td>
                      <Badge variant={statusVariant[status]}>{status}</Badge>
                    </Td>
                    <Td>{employeeAbility.trainingDays}</Td>
                    <Td>
                      {employeeAbility.lastTrainingDate
                        ? formatDate(employeeAbility.lastTrainingDate)
                        : "–"}
                    </Td>
                    <Td>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            aria-label={t`Actions`}
                            variant="ghost"
                            icon={<LuEllipsisVertical />}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={!permissions.can("update", "resources")}
                            onClick={() =>
                              navigate(
                                path.to.employeeAbility(
                                  abilityId,
                                  employeeAbility.id
                                )
                              )
                            }
                          >
                            <LuPencil className="mr-2" />
                            <Trans>Edit</Trans>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            destructive
                            disabled={!permissions.can("update", "resources")}
                            onClick={() =>
                              navigate(
                                path.to.deleteEmployeeAbility(
                                  abilityId,
                                  employeeAbility.id
                                )
                              )
                            }
                          >
                            <LuTrash className="mr-2" />
                            <Trans>Remove</Trans>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
};

export default AbilityEmployeesTable;
