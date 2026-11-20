// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { useEffect, useState } from "react";
import { useRealtime } from "~/hooks";
import type { OperationLossData } from "~/services/operation-losses.server";

/**
 * The operation's stops, stop reasons and loss inputs, from the loader's
 * deferred promise. A stop logged anywhere revalidates the page, which hands
 * a new promise here; the last value stays on screen until it resolves.
 */
export function useOperationLosses(
  operationId: string,
  promise: Promise<OperationLossData>
): OperationLossData | null {
  useRealtime("operationStop", `jobOperationId=eq.${operationId}`);

  const [resolved, setResolved] = useState<{
    promise: Promise<OperationLossData>;
    data: OperationLossData;
  } | null>(null);

  useEffect(() => {
    let active = true;
    promise.then((data) => {
      if (active) setResolved({ promise, data });
    });
    return () => {
      active = false;
    };
  }, [promise]);

  return resolved?.data ?? null;
}

/** The stop still open on the operation, if any. */
export function openStopOf(losses: OperationLossData | null) {
  return losses?.stops.find((stop) => stop.endTime === null) ?? null;
}
