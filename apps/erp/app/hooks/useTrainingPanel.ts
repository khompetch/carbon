import { useMemo } from "react";
import { useFetcher, useLocation } from "react-router";
import { path } from "~/utils/path";
import { getTrainingForPath, getTrainingKey } from "~/utils/training";
import { useUser } from "./useUser";

const FLAG_PREFIX = "training:";

export function useTrainingPanel() {
  const { pathname } = useLocation();
  const { flags } = useUser();
  const fetcher = useFetcher({ key: "training-dismiss" });

  const training = useMemo(() => getTrainingForPath(pathname), [pathname]);
  const trainingKey = useMemo(() => getTrainingKey(pathname), [pathname]);

  const flagKey = trainingKey ? `${FLAG_PREFIX}${trainingKey}` : null;

  // Optimistic: check if there's a pending dismiss for THIS flag
  const pendingDismissFlag = fetcher.formData?.get("flag") as string | null;
  const isPendingDismiss = pendingDismissFlag === flagKey;

  const isDismissed = flagKey
    ? isPendingDismiss || flags[flagKey] === true
    : false;

  const isOpen = !!training && !!flagKey && !isDismissed;

  const dismiss = () => {
    if (!flagKey) return;
    fetcher.submit(
      { intent: "flag", flag: flagKey, value: "true" },
      { method: "POST", action: path.to.acknowledge }
    );
  };

  return {
    isOpen,
    training,
    hasTraining: training !== null,
    dismiss
  };
}
