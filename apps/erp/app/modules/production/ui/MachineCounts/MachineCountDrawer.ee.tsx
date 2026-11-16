// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import type { Database } from "@carbon/database";
import {
  Button,
  Combobox,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  IconButton,
  useShortcutKeys,
  VStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNumberFormatter } from "@react-aria/i18n";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { LuChevronDown, LuChevronUp } from "react-icons/lu";
import { useFetcher, useNavigate, useSearchParams } from "react-router";
import { FieldEmptyState } from "~/components/Form";
import { usePermissions } from "~/hooks";
import { MACHINE_TIME_REVIEW_SHORTCUTS } from "~/shortcuts";
import { path } from "~/utils/path";
import type { getUnattributedMachineCount } from "../../production.service";
import { MachineTimeInstant } from "../MachineTime/MachineTimeTable.ee";
import { useMachineCountReasonLabels } from "./MachineCountTable.ee";

type JobOperationStatus = Database["public"]["Enums"]["jobOperationStatus"];

type MachineCount = NonNullable<
  Awaited<ReturnType<typeof getUnattributedMachineCount>>["data"]
>;

type MachineCountDrawerProps = {
  machineCount: MachineCount;
  timeZone: string;
  queue: {
    position: number | null;
    total: number;
    previousId: string | null;
    nextId: string | null;
  };
  operationOptions: {
    value: string;
    label: string;
    workCenterName: string | null;
    status: JobOperationStatus | null;
  }[];
  /** The reads that failed: the drawer says so instead of showing them empty. */
  loadErrors: { queue: boolean; operations: boolean };
  onClose: () => void;
};

const MachineCountDrawer = ({
  machineCount,
  timeZone,
  queue,
  operationOptions,
  loadErrors,
  onClose
}: MachineCountDrawerProps) => {
  const { t } = useLingui();
  const permissions = usePermissions();
  const numberFormatter = useNumberFormatter();
  const reasonLabels = useMachineCountReasonLabels();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher();

  const isBusy = fetcher.state !== "idle";
  const canAnswer = permissions.can("update", "production");
  const isDismissing = fetcher.formData?.get("intent") === "dismiss";
  const workCenterName =
    machineCount.workCenter?.name ?? machineCount.workCenterId;

  // A queue move replaces the entry, so Back leaves the review instead of
  // walking back through every row.
  const goTo = (id: string | null) => {
    if (!id) return;
    navigate(`${path.to.unattributedMachineCount(id)}?${searchParams}`, {
      replace: true
    });
  };

  const statusLabels: Record<JobOperationStatus, string> = {
    Todo: t`Todo`,
    Ready: t`Ready`,
    Waiting: t`Waiting`,
    "In Progress": t`In Progress`,
    Paused: t`Paused`,
    Done: t`Done`,
    Canceled: t`Canceled`
  };
  const searchOptions = operationOptions.map(
    ({ workCenterName, status, ...option }) => ({
      ...option,
      helper: workCenterName ?? (status ? statusLabels[status] : undefined)
    })
  );

  // An answer moves on to the row below, else the row above, else the list.
  const nextId = queue.nextId ?? queue.previousId ?? "";

  // One answer per row: a second click before the fetcher re-renders as busy
  // must not post twice.
  const answered = useRef(false);
  // A failed answer leaves the drawer on this row; let it be answered again.
  useEffect(() => {
    if (fetcher.state === "idle") answered.current = false;
  }, [fetcher.state]);
  const answer = (submission: Record<string, string>) => {
    if (!canAnswer || isBusy || answered.current) return;
    answered.current = true;
    fetcher.submit({ ...submission, nextId }, { method: "post" });
  };
  const assign = (jobOperationId: string) =>
    answer({ intent: "assign", jobOperationId });
  const dismiss = () => answer({ intent: "dismiss" });

  useShortcutKeys({
    shortcut: MACHINE_TIME_REVIEW_SHORTCUTS.next,
    action: (event) => {
      if (!event.repeat) goTo(queue.nextId);
    },
    disabled: isBusy || !queue.nextId
  });
  useShortcutKeys({
    shortcut: MACHINE_TIME_REVIEW_SHORTCUTS.previous,
    action: (event) => {
      if (!event.repeat) goTo(queue.previousId);
    },
    disabled: isBusy || !queue.previousId
  });

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* No autofocus: it would ring the Previous button on every row. */}
      <DrawerContent onOpenAutoFocus={(event) => event.preventDefault()}>
        <DrawerHeader className="flex-row items-center justify-between gap-4 pr-14 max-md:justify-between max-md:pl-4 max-md:text-left">
          <div className="flex min-w-0 flex-col gap-1">
            <DrawerTitle>{workCenterName}</DrawerTitle>
            <DrawerDescription>
              <Trans>Unattributed Counts</Trans>
            </DrawerDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="mr-1 text-xs tabular-nums text-muted-foreground">
              {loadErrors.queue || queue.position === null ? null : (
                <Trans>
                  {queue.position} of {queue.total}
                </Trans>
              )}
            </span>
            <IconButton
              aria-label={t`Previous`}
              icon={<LuChevronUp />}
              variant="ghost"
              isDisabled={!queue.previousId || isBusy}
              onClick={() => goTo(queue.previousId)}
            />
            <IconButton
              aria-label={t`Next`}
              icon={<LuChevronDown />}
              variant="ghost"
              isDisabled={!queue.nextId || isBusy}
              onClick={() => goTo(queue.nextId)}
            />
          </div>
        </DrawerHeader>
        <DrawerBody>
          <VStack spacing={4}>
            <div className="w-full divide-y divide-border border-y border-border">
              <DetailRow label={t`Start`}>
                <MachineTimeInstant
                  value={machineCount.periodStart}
                  timeZone={timeZone}
                />
              </DetailRow>
              <DetailRow label={t`End`}>
                <MachineTimeInstant
                  value={machineCount.periodEnd}
                  timeZone={timeZone}
                />
              </DetailRow>
              <DetailRow label={t`Quantity`}>
                <span className="tabular-nums">
                  {numberFormatter.format(machineCount.quantity)}
                </span>
              </DetailRow>
              <DetailRow label={t`Scrap`}>
                <span className="tabular-nums">
                  {numberFormatter.format(machineCount.scrapQuantity)}
                </span>
              </DetailRow>
              <DetailRow label={t`Reason`}>
                {reasonLabels[machineCount.reason]}
              </DetailRow>
              {machineCount.detail ? (
                <DetailRow label={t`Detail`}>{machineCount.detail}</DetailRow>
              ) : null}
            </div>

            <div className="flex w-full flex-col gap-2">
              <h3 className="text-sm font-medium">
                <Trans>Which operation made these pieces?</Trans>
              </h3>
              <Combobox
                aria-label={t`Job or operation`}
                size="sm"
                value=""
                options={searchOptions}
                placeholder={t`Search jobs and operations`}
                emptyMessage={
                  loadErrors.operations ? (
                    <FieldEmptyState
                      title={t`Could not load operations`}
                      description={t`Reload the page to try again.`}
                    />
                  ) : (
                    <FieldEmptyState
                      title={t`No open operations`}
                      description={t`No job at this location has an open operation.`}
                    />
                  )
                }
                isReadOnly={!canAnswer || isBusy}
                onChange={(jobOperationId) => {
                  if (jobOperationId) assign(jobOperationId);
                }}
              />
            </div>
          </VStack>
        </DrawerBody>
        <DrawerFooter>
          <Button
            variant="secondary"
            isDisabled={!canAnswer || isBusy}
            isLoading={isDismissing}
            onClick={dismiss}
          >
            <Trans>Dismiss</Trans>
          </Button>
          <Button
            variant="secondary"
            isDisabled={!queue.nextId || isBusy}
            rightIcon={<LuChevronDown />}
            onClick={() => goTo(queue.nextId)}
          >
            <Trans>Skip</Trans>
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};

// Same row as the machine time drawer's: label left, value right.
function DetailRow({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 text-base sm:text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">
        {children}
      </span>
    </div>
  );
}

export default MachineCountDrawer;
