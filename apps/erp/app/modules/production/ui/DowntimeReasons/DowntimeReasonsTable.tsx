import { Badge, MenuIcon, MenuItem } from "@carbon/react";
import { useLingui } from "@lingui/react/macro";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback, useMemo } from "react";
import { LuCircleGauge, LuPencil, LuTrash } from "react-icons/lu";
import { useNavigate } from "react-router";
import { Hyperlink, New, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import { usePermissions, useUrlParams } from "~/hooks";
import { useCustomColumns } from "~/hooks/useCustomColumns";
import { path } from "~/utils/path";
import type { DowntimeReason } from "../../types";

type DowntimeReasonsTableProps = {
  data: DowntimeReason[];
  count: number;
};

const DowntimeReasonsTable = memo(
  ({ data, count }: DowntimeReasonsTableProps) => {
    const [params] = useUrlParams();
    const { t } = useLingui();
    const navigate = useNavigate();
    const permissions = usePermissions();

    const customColumns = useCustomColumns<DowntimeReason>("downtimeReason");
    const columns = useMemo<ColumnDef<DowntimeReason>[]>(() => {
      const defaultColumns: ColumnDef<DowntimeReason>[] = [
        {
          accessorKey: "name",
          header: t`Downtime Reason`,
          cell: ({ row }) => (
            <Hyperlink to={row.original.id}>
              <Enumerable value={row.original.name} />
            </Hyperlink>
          ),
          meta: {
            icon: <LuCircleGauge />
          }
        },
        {
          accessorKey: "type",
          header: t`Type`,
          cell: ({ row }) => (
            <Badge variant={row.original.type === "Planned" ? "yellow" : "red"}>
              {row.original.type}
            </Badge>
          ),
          meta: {
            icon: <LuCircleGauge />
          }
        }
      ];
      return [...defaultColumns, ...customColumns];
    }, [customColumns, t]);

    const renderContextMenu = useCallback(
      (row: DowntimeReason) => {
        return (
          <>
            <MenuItem
              onClick={() => {
                navigate(
                  `${path.to.downtimeReason(row.id)}?${params.toString()}`
                );
              }}
            >
              <MenuIcon icon={<LuPencil />} />
              {t`Edit Downtime Reason`}
            </MenuItem>
            <MenuItem
              destructive
              disabled={!permissions.can("delete", "production")}
              onClick={() => {
                navigate(
                  `${path.to.deleteDowntimeReason(row.id)}?${params.toString()}`
                );
              }}
            >
              <MenuIcon icon={<LuTrash />} />
              {t`Delete Downtime Reason`}
            </MenuItem>
          </>
        );
      },
      [navigate, params, permissions, t]
    );

    return (
      <Table<DowntimeReason>
        data={data}
        columns={columns}
        count={count}
        primaryAction={
          permissions.can("create", "production") && (
            <New
              label={t`Downtime Reason`}
              to={`${path.to.newDowntimeReason}?${params.toString()}`}
            />
          )
        }
        renderContextMenu={renderContextMenu}
        title={t`Downtime Reasons`}
      />
    );
  }
);

DowntimeReasonsTable.displayName = "DowntimeReasonsTable";
export default DowntimeReasonsTable;
