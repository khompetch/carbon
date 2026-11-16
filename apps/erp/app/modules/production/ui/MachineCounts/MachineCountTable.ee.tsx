// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { Button, MENU_ITEM_SHORTCUTS, MenuIcon, MenuItem } from "@carbon/react";
import { formatDateTimeInZone } from "@carbon/utils";
import { useLingui } from "@lingui/react/macro";
import { useLocale, useNumberFormatter } from "@react-aria/i18n";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback, useMemo } from "react";
import {
  LuCalendar,
  LuCircleAlert,
  LuEye,
  LuFactory,
  LuHash,
  LuMapPin,
  LuText,
  LuTrash
} from "react-icons/lu";
import { useNavigate } from "react-router";
import { Hyperlink, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import { useUrlParams } from "~/hooks";
import { path } from "~/utils/path";
import type { getUnattributedMachineCounts } from "../../production.service";
import {
  MachineTimeInstant,
  useMachineTimeZone
} from "../MachineTime/MachineTimeTable.ee";
import {
  type UnattributedMachineCountReason,
  unattributedMachineCountReasons
} from "./machine-count-filters.ee";

export type UnattributedMachineCount = NonNullable<
  Awaited<ReturnType<typeof getUnattributedMachineCounts>>["data"]
>[number];

/** Why no operation took the pieces, in words: the list and the drawer. */
export function useMachineCountReasonLabels() {
  const { t } = useLingui();
  return useMemo<Record<UnattributedMachineCountReason, string>>(
    () => ({
      NoLoad: t`No operation loaded`,
      Blocked: t`Maintenance`,
      OperationClosed: t`Operation done or canceled`,
      OverTarget: t`Over the target quantity`,
      SerialNeedsSendEachPulse: t`Serial item needs Send each pulse immediately`,
      NoScrapReason: t`No scrap reason set`,
      Refused: t`Refused`
    }),
    [t]
  );
}

type MachineCountTableProps = {
  data: UnattributedMachineCount[];
  count: number;
  nextCursor: string | null;
  workCenters: { id: string | null; name: string | null }[];
  locations: { id: string; name: string }[];
};

const MachineCountTable = memo(
  ({
    data,
    count,
    nextCursor,
    workCenters,
    locations
  }: MachineCountTableProps) => {
    const [params] = useUrlParams();
    const { t } = useLingui();
    const { locale } = useLocale();
    const navigate = useNavigate();
    const numberFormatter = useNumberFormatter();
    const timeZoneOf = useMachineTimeZone();
    const reasonLabels = useMachineCountReasonLabels();

    const instant = useCallback(
      (value: string, row: UnattributedMachineCount) =>
        formatDateTimeInZone(value, timeZoneOf(row), locale, {
          timeStyle: "short"
        }),
      [locale, timeZoneOf]
    );

    const columns = useMemo<ColumnDef<UnattributedMachineCount>[]>(
      () => [
        {
          accessorKey: "workCenterId",
          header: t`Work Center`,
          enableSorting: false,
          cell: ({ row }) => (
            <Hyperlink
              to={`${path.to.unattributedMachineCount(row.original.id)}?${params.toString()}`}
            >
              <Enumerable
                value={
                  row.original.workCenter?.name ?? row.original.workCenterId
                }
              />
            </Hyperlink>
          ),
          meta: {
            mobile: "P1",
            icon: <LuFactory />,
            filter: {
              type: "static",
              options: workCenters.flatMap((workCenter) =>
                workCenter.id
                  ? [
                      {
                        value: workCenter.id,
                        label: <Enumerable value={workCenter.name} />
                      }
                    ]
                  : []
              )
            },
            exportValue: (row: UnattributedMachineCount) =>
              row.workCenter?.name ?? null
          }
        },
        {
          id: "locationId",
          header: t`Location`,
          enableSorting: false,
          cell: ({ row }) => (
            <Enumerable
              value={row.original.workCenter?.location?.name ?? null}
            />
          ),
          meta: {
            icon: <LuMapPin />,
            filter: {
              type: "static",
              options: locations.map((location) => ({
                value: location.id,
                label: <Enumerable value={location.name} />
              }))
            },
            exportValue: (row: UnattributedMachineCount) =>
              row.workCenter?.location?.name ?? null
          }
        },
        {
          accessorKey: "periodStart",
          header: t`Start`,
          enableSorting: false,
          cell: ({ row }) => (
            <MachineTimeInstant
              value={row.original.periodStart}
              timeZone={timeZoneOf(row.original)}
            />
          ),
          meta: {
            mobile: "P2",
            icon: <LuCalendar />,
            exportValue: (row: UnattributedMachineCount) =>
              instant(row.periodStart, row)
          }
        },
        {
          accessorKey: "periodEnd",
          header: t`End`,
          enableSorting: false,
          cell: ({ row }) => (
            <MachineTimeInstant
              value={row.original.periodEnd}
              timeZone={timeZoneOf(row.original)}
            />
          ),
          meta: {
            icon: <LuCalendar />,
            exportValue: (row: UnattributedMachineCount) =>
              instant(row.periodEnd, row)
          }
        },
        {
          accessorKey: "quantity",
          header: t`Quantity`,
          enableSorting: false,
          cell: ({ row }) => (
            <span className="tabular-nums">
              {numberFormatter.format(row.original.quantity)}
            </span>
          ),
          meta: {
            mobile: "P3",
            icon: <LuHash />
          }
        },
        {
          accessorKey: "scrapQuantity",
          header: t`Scrap`,
          enableSorting: false,
          cell: ({ row }) => (
            <span className="tabular-nums">
              {numberFormatter.format(row.original.scrapQuantity)}
            </span>
          ),
          meta: {
            icon: <LuTrash />
          }
        },
        {
          accessorKey: "reason",
          header: t`Reason`,
          enableSorting: false,
          cell: ({ row }) => (
            <Enumerable value={reasonLabels[row.original.reason]} />
          ),
          meta: {
            icon: <LuCircleAlert />,
            filter: {
              type: "static",
              options: unattributedMachineCountReasons.map((reason) => ({
                value: reason,
                label: <Enumerable value={reasonLabels[reason]} />
              }))
            },
            exportValue: (row: UnattributedMachineCount) =>
              reasonLabels[row.reason]
          }
        },
        {
          accessorKey: "detail",
          header: t`Detail`,
          enableSorting: false,
          cell: ({ row }) => (
            <span className="block max-w-80 truncate">
              {row.original.detail}
            </span>
          ),
          meta: {
            icon: <LuText />
          }
        }
      ],
      [
        instant,
        locations,
        numberFormatter,
        params,
        reasonLabels,
        t,
        timeZoneOf,
        workCenters
      ]
    );

    const renderContextMenu = useCallback(
      (row: UnattributedMachineCount) => (
        <MenuItem
          shortcut={MENU_ITEM_SHORTCUTS.view}
          onClick={() => {
            navigate(
              `${path.to.unattributedMachineCount(row.id)}?${params.toString()}`
            );
          }}
        >
          <MenuIcon icon={<LuEye />} />
          {t`View Machine Count`}
        </MenuItem>
      ),
      [navigate, params, t]
    );

    // The drawer walks the queue in this list's order, so Review starts at
    // the top row.
    const firstId = data[0]?.id;

    return (
      <Table<UnattributedMachineCount>
        data={data}
        columns={columns}
        count={count}
        // Filters are parsed by the loader, not the list registry: no `listKey`.
        infinite={{ dataKey: "machineCounts", nextCursor }}
        // The review queue walks one fixed order (newest period start, then
        // id), so the list offers no sort.
        sort={null}
        renderContextMenu={renderContextMenu}
        getRowLabel={(row) =>
          `${row.workCenter?.name ?? ""} ${instant(row.periodStart, row)}`.trim()
        }
        title={t`Unattributed Counts`}
        primaryAction={
          firstId ? (
            <Button
              onClick={() =>
                navigate(
                  `${path.to.unattributedMachineCount(firstId)}?${params.toString()}`
                )
              }
            >
              {t`Review`}
            </Button>
          ) : undefined
        }
      />
    );
  }
);

MachineCountTable.displayName = "MachineCountTable";
export default MachineCountTable;
