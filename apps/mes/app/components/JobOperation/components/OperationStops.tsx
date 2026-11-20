// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { OeeLossCategory } from "@carbon/planning/oee";
import { useAction } from "@carbon/query";
import {
  Button,
  cn,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Textarea,
  useDisclosure,
  useInterval
} from "@carbon/react";
import { formatDurationMilliseconds } from "@carbon/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { LuCirclePause, LuPlay } from "react-icons/lu";
import { useFetcher } from "react-router";
import type {
  OperationLossData,
  OperationStopRow
} from "~/services/operation-losses.server";
import { path } from "~/utils/path";
import { openStopOf } from "../hooks/useOperationLosses";
import { IconButtonWithTooltip } from "./Controls";

function useLossLabels() {
  const { t } = useLingui();
  return {
    Breakdown: t`Breakdown`,
    "Setup & Adjustment": t`Setup & adjustment`,
    "Small Stop": t`Small stop`
  } satisfies Record<OeeLossCategory, string>;
}

function useElapsed(startTime: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), startTime ? 1000 : null);
  return startTime ? Math.max(0, now - Date.parse(startTime)) : 0;
}

function ResumeForm({
  operationId,
  className,
  layout
}: {
  operationId: string;
  className?: string;
  layout: "button" | "icon";
}) {
  const { t } = useLingui();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form
      method="post"
      action={path.to.operationStop}
      className={className}
    >
      <input type="hidden" name="intent" value="end" />
      <input type="hidden" name="jobOperationId" value={operationId} />
      {layout === "icon" ? (
        <IconButtonWithTooltip
          type="submit"
          variant="success"
          disabled={busy}
          icon={<LuPlay />}
          tooltip={t`Resume`}
        />
      ) : (
        <Button
          type="submit"
          size="lg"
          isLoading={busy}
          leftIcon={<LuPlay />}
          className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Trans>Resume</Trans>
        </Button>
      )}
    </fetcher.Form>
  );
}

/**
 * The dock's Log stop button, or Resume while the operation is stopped.
 * `layout="icon"` is the rail and phone bar size.
 */
export function LogStopControl({
  operationId,
  losses,
  disabled,
  layout
}: {
  operationId: string;
  losses: OperationLossData | null;
  disabled?: boolean;
  layout: "button" | "icon";
}) {
  const { t } = useLingui();
  const modal = useDisclosure();
  const openStop = openStopOf(losses);

  if (openStop) {
    return (
      <ResumeForm
        operationId={operationId}
        layout={layout}
        className="w-full"
      />
    );
  }

  return (
    <>
      {layout === "icon" ? (
        <IconButtonWithTooltip
          disabled={disabled || !losses}
          icon={<LuCirclePause className="text-red-600" />}
          tooltip={t`Log stop`}
          onClick={modal.onOpen}
        />
      ) : (
        <Button
          size="lg"
          variant="secondary"
          className="w-full"
          leftIcon={<LuCirclePause className="text-red-600" />}
          isDisabled={disabled || !losses}
          onClick={modal.onOpen}
        >
          <Trans>Log stop</Trans>
        </Button>
      )}
      <StopReasonModal
        operationId={operationId}
        reasons={losses?.stopReasons ?? []}
        isOpen={modal.isOpen}
        onClose={modal.onClose}
      />
    </>
  );
}

function StopReasonModal({
  operationId,
  reasons,
  isOpen,
  onClose
}: {
  operationId: string;
  reasons: OperationLossData["stopReasons"];
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ModalContent size="large">
        <StopReasonBody
          operationId={operationId}
          reasons={reasons}
          onClose={onClose}
        />
      </ModalContent>
    </Modal>
  );
}

const LOSS_ORDER: OeeLossCategory[] = [
  "Breakdown",
  "Setup & Adjustment",
  "Small Stop"
];

function StopReasonBody({
  operationId,
  reasons,
  onClose
}: {
  operationId: string;
  reasons: OperationLossData["stopReasons"];
  onClose: () => void;
}) {
  const { t } = useLingui();
  const lossLabels = useLossLabels();
  const fetcher = useAction<{ success: boolean }>({
    onSuccess: (data) => {
      if (data?.success) onClose();
    }
  });
  const busy = fetcher.state !== "idle";

  return (
    <fetcher.Form method="post" action={path.to.operationStop}>
      <input type="hidden" name="intent" value="start" />
      <input type="hidden" name="jobOperationId" value={operationId} />
      <ModalHeader>
        <ModalTitle>
          <Trans>Why did the operation stop?</Trans>
        </ModalTitle>
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-5">
          {/* The note comes first: tapping a reason logs the stop. */}
          <Textarea
            name="notes"
            aria-label={t`Note`}
            placeholder={t`Add a note (optional)`}
            className="text-base"
          />
          {reasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                No stop reasons are set up. Ask a supervisor to add them in
                Production → Stop Reasons.
              </Trans>
            </p>
          ) : (
            LOSS_ORDER.map((loss) => {
              const group = reasons.filter((reason) => reason.oeeLoss === loss);
              if (group.length === 0) return null;
              return (
                <section key={loss} className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {lossLabels[loss]}
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {group.map((reason) => (
                      <Button
                        key={reason.id}
                        type="submit"
                        name="stopReasonId"
                        value={reason.id}
                        size="lg"
                        variant="secondary"
                        isDisabled={busy}
                        className="h-14 justify-start text-base"
                      >
                        {reason.name}
                      </Button>
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="lg" onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
      </ModalFooter>
    </fetcher.Form>
  );
}

/** The red strip at the top of the page while the operation is stopped. */
export function StopBanner({
  operationId,
  stop
}: {
  operationId: string;
  stop: OperationStopRow;
}) {
  const lossLabels = useLossLabels();
  const elapsed = useElapsed(stop.startTime);
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4",
        "sm:flex-row sm:items-center"
      )}
    >
      <LuCirclePause aria-hidden className="size-8 shrink-0 text-red-600" />
      <div className="min-w-0 flex-1">
        <p className="text-xl font-semibold text-red-700 dark:text-red-400">
          <Trans>Stopped</Trans>
          {" · "}
          <span className="tabular-nums">
            {formatDurationMilliseconds(elapsed, { style: "short" })}
          </span>
        </p>
        <p className="line-clamp-1 text-base text-muted-foreground">
          {stop.reasonName} · {lossLabels[stop.oeeLoss]}
          {stop.notes ? ` · ${stop.notes}` : ""}
        </p>
      </div>
      <ResumeForm
        operationId={operationId}
        layout="button"
        className="sm:w-48"
      />
    </div>
  );
}
