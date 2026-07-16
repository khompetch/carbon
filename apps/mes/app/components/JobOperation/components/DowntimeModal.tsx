import {
  Badge,
  Button,
  Combobox,
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Textarea,
  toast
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { path } from "~/utils/path";

type DowntimeReasonOption = {
  id: string;
  name: string;
  type: "Planned" | "Unplanned";
};

type OpenDowntime = {
  id: string;
  type: "Planned" | "Unplanned";
  startTime: string;
  notes: string | null;
  downtimeReasonId: string | null;
  isAuto?: boolean;
};

export function DowntimeModal({
  workCenterId,
  onClose
}: {
  workCenterId: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const dataFetcher = useFetcher<{
    reasons: DowntimeReasonOption[];
    openDowntime: OpenDowntime | null;
  }>();
  const submitFetcher = useFetcher<{ success: boolean; message?: string }>();

  const [reasonId, setReasonId] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    dataFetcher.load(`${path.to.downtime}?workCenterId=${workCenterId}`);
    // biome-ignore lint/correctness/useExhaustiveDependencies: load once per work center
  }, [workCenterId]);

  useEffect(() => {
    if (submitFetcher.state === "idle" && submitFetcher.data) {
      if (submitFetcher.data.success) {
        toast.success(submitFetcher.data.message);
        onClose();
      } else if (submitFetcher.data.message) {
        toast.error(submitFetcher.data.message);
      }
    }
  }, [submitFetcher.state, submitFetcher.data, onClose]);

  const reasons = dataFetcher.data?.reasons ?? [];
  const openDowntime = dataFetcher.data?.openDowntime ?? null;
  const isLoading = dataFetcher.state !== "idle" && !dataFetcher.data;
  const isSubmitting = submitFetcher.state !== "idle";

  const reasonOptions = useMemo(
    () =>
      reasons.map((reason) => ({
        value: reason.id,
        label: reason.name,
        helper: reason.type
      })),
    [reasons]
  );

  const selectedReason = reasons.find((reason) => reason.id === reasonId);
  const openReason = openDowntime
    ? reasons.find((reason) => reason.id === openDowntime.downtimeReasonId)
    : null;

  const startDowntime = () => {
    if (!selectedReason) {
      toast.error(t`Please select a downtime reason`);
      return;
    }
    const formData = new FormData();
    formData.append("intent", "start");
    formData.append("workCenterId", workCenterId);
    formData.append("downtimeReasonId", selectedReason.id);
    formData.append("downtimeType", selectedReason.type);
    formData.append("notes", notes);
    submitFetcher.submit(formData, {
      method: "post",
      action: path.to.downtime
    });
  };

  const endDowntime = () => {
    const formData = new FormData();
    formData.append("intent", "end");
    formData.append("workCenterId", workCenterId);
    submitFetcher.submit(formData, {
      method: "post",
      action: path.to.downtime
    });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ModalContent>
        <ModalHeader>
          <ModalTitle>
            {openDowntime ? (
              <Trans>Work center is down</Trans>
            ) : (
              <Trans>Record downtime</Trans>
            )}
          </ModalTitle>
          <ModalDescription>
            {openDowntime ? (
              <Trans>
                End the downtime when the work center is running again.
              </Trans>
            ) : (
              <Trans>
                Select a reason to mark this work center as down. Downtime
                counts against OEE until it is ended.
              </Trans>
            )}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-4">
              <Trans>Loading...</Trans>
            </div>
          ) : openDowntime ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-2">
                <Badge
                  variant={openDowntime.type === "Planned" ? "yellow" : "red"}
                >
                  {openDowntime.type}
                </Badge>
                {openDowntime.isAuto && (
                  <Badge variant="secondary">
                    <Trans>Auto</Trans>
                  </Badge>
                )}
                <span className="font-medium">
                  {openReason?.name ?? <Trans>Downtime</Trans>}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                <Trans>
                  Since {new Date(openDowntime.startTime).toLocaleString()}
                </Trans>
              </div>
              {openDowntime.notes && (
                <div className="text-sm">{openDowntime.notes}</div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <label
                  htmlFor="downtime-reason"
                  className="block text-sm font-medium mb-1"
                >
                  <Trans>Reason</Trans>
                </label>
                <Combobox
                  placeholder={t`Select a downtime reason...`}
                  value={reasonId}
                  onChange={setReasonId}
                  options={reasonOptions}
                />
                {reasons.length === 0 && (
                  <p className="text-sm text-muted-foreground mt-2">
                    <Trans>
                      No downtime reasons configured. Add them in the ERP under
                      Production settings.
                    </Trans>
                  </p>
                )}
              </div>
              <Textarea
                placeholder={t`Notes (optional)`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" size="lg" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          {openDowntime ? (
            <Button
              variant="primary"
              size="lg"
              onClick={endDowntime}
              isLoading={isSubmitting}
              isDisabled={isSubmitting}
            >
              <Trans>End Downtime</Trans>
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="lg"
              onClick={startDowntime}
              isLoading={isSubmitting}
              isDisabled={isSubmitting || !reasonId || reasons.length === 0}
            >
              <Trans>Start Downtime</Trans>
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
