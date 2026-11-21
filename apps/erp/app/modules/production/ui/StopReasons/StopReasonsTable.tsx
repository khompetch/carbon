// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { MENU_ITEM_SHORTCUTS, MenuIcon, MenuItem } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback, useMemo } from "react";
import { LuChartPie, LuOctagonPause, LuPencil, LuTrash } from "react-icons/lu";
import { useNavigate } from "react-router";
import { Hyperlink, New, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import type { InfiniteOptions } from "~/components/Table";
import { usePermissions, useUrlParams } from "~/hooks";
import { useCustomColumns } from "~/hooks/useCustomColumns";
import { path } from "~/utils/path";
import type { StopReason } from "../../types";
import { useOeeLossLabel } from "./useOeeLossLabel";

type StopReasonsTableProps = {
  data: StopReason[];
  count: number;
  infinite: InfiniteOptions;
};

const StopReasonsTable = memo((props: StopReasonsTableProps) => {
  const { data, count, infinite } = props;
  const [params] = useUrlParams();
  const { t } = useLingui();
  const navigate = useNavigate();
  const permissions = usePermissions();
  const { label: oeeLossLabel, options: oeeLossOptions } = useOeeLossLabel();

  const customColumns = useCustomColumns<StopReason>("stopReason");
  const columns = useMemo<ColumnDef<StopReason>[]>(() => {
    const defaultColumns: ColumnDef<StopReason>[] = [
      {
        accessorKey: "name",
        header: t`Stop Reason`,
        cell: ({ row }) => (
          <Hyperlink to={row.original.id}>
            <Enumerable value={row.original.name} />
          </Hyperlink>
        ),
        meta: {
          mobile: "P1",
          icon: <LuOctagonPause />
        }
      },
      {
        accessorKey: "oeeLoss",
        header: t`Loss`,
        cell: ({ row }) => (
          <Enumerable value={oeeLossLabel(row.original.oeeLoss)} />
        ),
        meta: {
          icon: <LuChartPie />,
          filter: {
            type: "static",
            options: oeeLossOptions
          }
        }
      }
    ];
    return [...defaultColumns, ...customColumns];
  }, [customColumns, oeeLossLabel, oeeLossOptions, t]);

  const renderContextMenu = useCallback(
    (row: StopReason) => {
      return (
        <>
          <MenuItem
            shortcut={MENU_ITEM_SHORTCUTS.edit}
            onClick={() => {
              navigate(`${path.to.stopReason(row.id)}?${params.toString()}`);
            }}
          >
            <MenuIcon icon={<LuPencil />} />
            <Trans>Edit Stop Reason</Trans>
          </MenuItem>
          <MenuItem
            shortcut={MENU_ITEM_SHORTCUTS.delete}
            destructive
            disabled={!permissions.can("delete", "production")}
            onClick={() => {
              navigate(
                `${path.to.deleteStopReason(row.id)}?${params.toString()}`
              );
            }}
          >
            <MenuIcon icon={<LuTrash />} />
            <Trans>Delete Stop Reason</Trans>
          </MenuItem>
        </>
      );
    },
    [navigate, params, permissions]
  );

  return (
    <Table<StopReason>
      data={data}
      columns={columns}
      count={count}
      infinite={infinite}
      primaryAction={
        permissions.can("create", "production") && (
          <New
            label={t`Stop Reason`}
            to={`${path.to.newStopReason}?${params.toString()}`}
          />
        )
      }
      renderContextMenu={renderContextMenu}
      title={t`Stop Reasons`}
    />
  );
});

StopReasonsTable.displayName = "StopReasonsTable";
export default StopReasonsTable;
