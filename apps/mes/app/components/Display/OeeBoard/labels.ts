// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { OeeBoardState, OeeLossKey } from "@carbon/planning/oee";
import { useLingui } from "@lingui/react/macro";

/** The words for each machine state and each loss, on every zone alike. */
export function useOeeLabels() {
  const { t } = useLingui();
  const states: Record<OeeBoardState, string> = {
    Running: t`Running`,
    Idle: t`Idle`,
    Down: t`Down`,
    Offline: t`Offline`,
    Unknown: t`No state`,
    NotPlanned: t`Not planned`
  };
  const losses: Record<OeeLossKey, string> = {
    Down: t`Down`,
    Idle: t`Idle`,
    Offline: t`Offline`,
    Unknown: t`No state`,
    Speed: t`Speed loss`,
    Scrap: t`Scrap`
  };
  return { states, losses };
}
