import { MenuIcon, MenuItem } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback, useMemo } from "react";
import {
  LuCalendarClock,
  LuGraduationCap,
  LuPencil,
  LuTrash,
  LuUsers
} from "react-icons/lu";
import { useNavigate } from "react-router";
import { Hyperlink, New, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import { usePermissions, useUrlParams } from "~/hooks";
import { path } from "~/utils/path";
import type { Abilities } from "../../types";

type Ability = Abilities[number];

type AbilitiesTableProps = {
  data: Abilities;
  count: number;
};

const AbilitiesTable = memo(({ data, count }: AbilitiesTableProps) => {
  const { t } = useLingui();
  const [params] = useUrlParams();
  const navigate = useNavigate();
  const permissions = usePermissions();

  const columns = useMemo<ColumnDef<Ability>[]>(() => {
    return [
      {
        accessorKey: "name",
        header: t`Ability`,
        cell: ({ row }) => (
          <Hyperlink to={path.to.ability(row.original.id)}>
            <Enumerable value={row.original.name} />
          </Hyperlink>
        ),
        meta: {
          icon: <LuGraduationCap />
        }
      },
      {
        id: "employees",
        header: t`Employees`,
        cell: ({ row }) => row.original.employeeAbility?.length ?? 0,
        meta: {
          icon: <LuUsers />,
          exportValue: (row: Ability) => row.employeeAbility?.length ?? 0
        }
      },
      {
        accessorKey: "shadowWeeks",
        header: t`Shadow Weeks`,
        cell: ({ row }) => row.original.shadowWeeks,
        meta: {
          icon: <LuCalendarClock />
        }
      }
    ];
  }, [t]);

  const renderContextMenu = useCallback(
    (row: Ability) => {
      return (
        <>
          <MenuItem
            onClick={() => {
              navigate(path.to.ability(row.id));
            }}
          >
            <MenuIcon icon={<LuPencil />} />
            <Trans>Edit Ability</Trans>
          </MenuItem>
          <MenuItem
            destructive
            disabled={!permissions.can("delete", "resources")}
            onClick={() => {
              navigate(`${path.to.deleteAbility(row.id)}?${params.toString()}`);
            }}
          >
            <MenuIcon icon={<LuTrash />} />
            <Trans>Delete Ability</Trans>
          </MenuItem>
        </>
      );
    },
    [navigate, params, permissions]
  );

  return (
    <Table<Ability>
      data={data}
      columns={columns}
      count={count}
      primaryAction={
        permissions.can("create", "resources") && (
          <New
            label={t`Ability`}
            to={`${path.to.newAbility}?${params.toString()}`}
          />
        )
      }
      renderContextMenu={renderContextMenu}
      title={t`Abilities`}
    />
  );
});

AbilitiesTable.displayName = "AbilitiesTable";
export default AbilitiesTable;
