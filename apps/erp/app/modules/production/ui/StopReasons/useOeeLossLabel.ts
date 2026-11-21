// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { oeeLossTypes } from "../../production.models";

type OeeLoss = (typeof oeeLossTypes)[number];

/** Translated labels for the OEE loss a stop reason counts against. */
export function useOeeLossLabel() {
  const { t } = useLingui();

  return useMemo(() => {
    const labels: Record<OeeLoss, string> = {
      Breakdown: t`Breakdown`,
      "Setup & Adjustment": t`Setup & Adjustment`,
      "Small Stop": t`Small Stop`
    };
    return {
      label: (value: string | null | undefined) =>
        value && value in labels ? labels[value as OeeLoss] : (value ?? null),
      options: oeeLossTypes.map((value) => ({ value, label: labels[value] }))
    };
  }, [t]);
}
