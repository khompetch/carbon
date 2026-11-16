// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { Trans } from "@lingui/react/macro";
import { LuHash } from "react-icons/lu";
import {
  UpgradeOverlay,
  UpgradeOverlayActions,
  UpgradeOverlayCard,
  UpgradeOverlayContent,
  UpgradeOverlayDescription,
  UpgradeOverlayIcon,
  UpgradeOverlayPreview,
  UpgradeOverlayTitle,
  UpgradeOverlayUpgradeButton
} from "~/components/UpgradeOverlay";
import type { UnattributedMachineCount } from "./MachineCountTable.ee";
import MachineCountTable from "./MachineCountTable.ee";

const mockRow = {
  companyId: "mock",
  createdAt: "2026-05-05T06:00:00Z",
  createdBy: "mock-user-1",
  updatedAt: null,
  updatedBy: null,
  jobOperationId: null
} as const;

const mockMachineCounts: UnattributedMachineCount[] = [
  {
    ...mockRow,
    id: "mock-1",
    workCenterId: "mock-wc-1",
    workCenter: {
      name: "Haas VF-2",
      locationId: "mock-location",
      location: { name: "Main Plant", timezone: "UTC" }
    },
    periodStart: "2026-05-05T06:12:00Z",
    periodEnd: "2026-05-05T06:13:00Z",
    quantity: 12,
    scrapQuantity: 0,
    reason: "NoLoad",
    detail: null
  },
  {
    ...mockRow,
    id: "mock-2",
    workCenterId: "mock-wc-2",
    workCenter: {
      name: "Mazak QTN-200",
      locationId: "mock-location",
      location: { name: "Main Plant", timezone: "UTC" }
    },
    periodStart: "2026-05-05T09:30:00Z",
    periodEnd: "2026-05-05T09:31:00Z",
    quantity: 4,
    scrapQuantity: 1,
    reason: "OverTarget",
    detail: null
  },
  {
    ...mockRow,
    id: "mock-3",
    workCenterId: "mock-wc-1",
    workCenter: {
      name: "Haas VF-2",
      locationId: "mock-location",
      location: { name: "Main Plant", timezone: "UTC" }
    },
    periodStart: "2026-05-05T13:05:00Z",
    periodEnd: "2026-05-05T13:06:00Z",
    quantity: 8,
    scrapQuantity: 0,
    reason: "Blocked",
    detail: null
  }
];

export default function MachineCountUpgradeOverlay() {
  return (
    <UpgradeOverlay>
      <UpgradeOverlayPreview>
        <MachineCountTable
          data={mockMachineCounts}
          count={mockMachineCounts.length}
          nextCursor={null}
          workCenters={[]}
          locations={[]}
        />
      </UpgradeOverlayPreview>
      <UpgradeOverlayCard>
        <UpgradeOverlayIcon>
          <LuHash className="size-6 text-muted-foreground" />
        </UpgradeOverlayIcon>
        <UpgradeOverlayContent>
          <UpgradeOverlayTitle>
            <Trans>Unattributed Counts</Trans>
          </UpgradeOverlayTitle>
          <UpgradeOverlayDescription>
            <Trans>
              Assign machine pieces that no operation could take to the right
              job, or dismiss them.
            </Trans>
          </UpgradeOverlayDescription>
        </UpgradeOverlayContent>
        <UpgradeOverlayActions>
          <UpgradeOverlayUpgradeButton />
        </UpgradeOverlayActions>
      </UpgradeOverlayCard>
    </UpgradeOverlay>
  );
}
