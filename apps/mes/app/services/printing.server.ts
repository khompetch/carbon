// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { getCarbonServiceRole } from "@carbon/auth/client.server";
import {
  claimTravelerPrint,
  releaseTravelerPrintClaim
} from "@carbon/database/travelers";
import { trigger } from "@carbon/jobs";
import { getLogger } from "@carbon/logger";
import { printOperationLabel } from "@carbon/printing/operation-label.server";
import { getCachedPrinterConfig } from "@carbon/printing/printing.server";
import { datetime } from "@carbon/utils";

type ServiceRole = Awaited<ReturnType<typeof getCarbonServiceRole>>;

const log = getLogger("mes", "printing");

/**
 * Auto-prints a unit's label when an MES path completes it at the first or
 * last operation of its make method. See `printOperationLabel`
 * (`@carbon/printing/operation-label.server`). Never throws.
 */
export async function autoPrintOperationLabel(
  args: Parameters<typeof printOperationLabel>[0]
) {
  return printOperationLabel(args);
}

/**
 * Prints a picking list's travelers (one per unit of every job on the list)
 * once, after a status change or a pick. With `companySettings.travelerLabels`
 * on and auto-print on at the location's inventory printer,
 * `claimTravelerPrint` (`@carbon/database/travelers`) sets the list's
 * `travelersPrintedAt` right before the print is queued; only the call that
 * sets it prints. Printer eligibility is checked BEFORE the claim, so a list
 * is never claimed while nothing would print: with the setting or auto-print
 * off, turning it on later still prints a list not yet claimed. A failed
 * enqueue gives the claim back (`releaseTravelerPrintClaim`), so the next pick
 * or status change tries again.
 *
 * Never throws: a print failure must not fail the pick or the status change.
 */
export async function printTravelersOnStart({
  serviceRole,
  pickingListId,
  companyId,
  userId
}: {
  serviceRole: ServiceRole;
  pickingListId: string;
  companyId: string;
  userId: string;
}): Promise<void> {
  try {
    const { data: settings } = await serviceRole
      .from("companySettings")
      .select("travelerLabels")
      .eq("id", companyId)
      .maybeSingle();
    if (settings?.travelerLabels !== true) return;

    const { data: pickingList, error: pickingListError } = await serviceRole
      .from("pickingList")
      .select("locationId, travelersPrintedAt")
      .eq("id", pickingListId)
      .eq("companyId", companyId)
      .maybeSingle();
    if (pickingListError) {
      log.error("Traveler print list read failed", {
        companyId,
        pickingListId,
        error: pickingListError
      });
      return;
    }
    // Already printed, or no printer to choose: nothing to claim.
    if (!pickingList?.locationId || pickingList.travelersPrintedAt) return;
    const locationId = pickingList.locationId;

    const config = await getCachedPrinterConfig(
      serviceRole,
      companyId,
      locationId,
      "inventory"
    );
    if (!(config?.autoPrint ?? true)) return;

    const at = datetime.timestamp();
    const claim = await claimTravelerPrint(serviceRole, {
      pickingListId,
      companyId,
      at
    });
    if (claim.error) {
      log.error("Traveler print claim failed", {
        companyId,
        pickingListId,
        error: claim.error
      });
      return;
    }
    if (!claim.claimed) return;

    try {
      await trigger("print-job", {
        sourceDocument: "PickingList",
        sourceDocumentId: pickingListId,
        companyId,
        userId,
        locationId
      });
    } catch (error) {
      log.error("Traveler print enqueue failed", {
        companyId,
        pickingListId,
        error
      });
      const release = await releaseTravelerPrintClaim(serviceRole, {
        pickingListId,
        companyId,
        at
      });
      if (release.error) {
        log.error("Traveler print claim release failed", {
          companyId,
          pickingListId,
          error: release.error
        });
      }
    }
  } catch (error) {
    log.error("Traveler print failed", { companyId, pickingListId, error });
  }
}
