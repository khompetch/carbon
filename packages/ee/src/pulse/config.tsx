// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import type { ComponentProps } from "react";
import { z } from "zod";
import { defineIntegration } from "../fns";
import { DEFAULT_MINIMUM_STATE_SECONDS } from "../oee/types";

const PulseSettingsSchema = z.object({
  minimumStateSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_MINIMUM_STATE_SECONDS)
});

export const Pulse = defineIntegration({
  name: "Pulse",
  id: "pulse",
  active: true,
  category: "Machine Monitoring",
  providerRole: "oee" as const,
  logo: Logo,
  setupInstructions: SetupInstructions,
  description:
    "Pulse is Carbon's own machine monitor. A sensor on each machine counts one pulse per cycle and sends it to Carbon over MQTT, through the Pulse ingest service. Map each device to a work center, and Carbon records machine time on the operation loaded on that work center. Run time with no loaded operation waits under Production → Unattributed Time for a supervisor.",
  shortDescription: "Record machine time from Pulse cycle sensors.",
  images: [],
  settingGroups: [
    {
      name: "Machine time",
      description: "How Carbon reads the machine states"
    }
  ],
  settings: [
    {
      name: "minimumStateSeconds",
      label: "Minimum state (seconds)",
      description:
        "A run or a stop shorter than this is ignored, so a brief pause does not split machine time.",
      group: "Machine time",
      type: "number" as const,
      required: true,
      value: DEFAULT_MINIMUM_STATE_SECONDS
    }
  ],
  schema: PulseSettingsSchema
});

function SetupInstructions() {
  return (
    <p className="text-sm text-muted-foreground">
      Run the Pulse ingest service and the MQTT broker beside Carbon, and
      register each device by its key. Then open the Devices tab and map each
      device to the work center it measures.
    </p>
  );
}

// A pulse train: a flat line with three cycle peaks. Monochrome, like the
// other integration logos, so it follows the theme.
function Logo(props: ComponentProps<"svg">) {
  return (
    <svg
      aria-hidden="true"
      {...props}
      viewBox="0 0 64 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      style={{ height: "2rem", width: "auto", ...props.style }}
    >
      <path d="M2 24h10V8h8v16h8V8h8v16h8V8h8v16h2" />
    </svg>
  );
}
