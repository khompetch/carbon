// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Database } from "@carbon/database";
import { shouldPrintOperationLabel } from "@carbon/database/travelers";
import { trigger } from "@carbon/lib/trigger";
import { getLogger } from "@carbon/logger";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isFirstOperationOfMakeMethod,
  isLastOperationOfMakeMethod
} from "./operation-routing";
import { getCachedPrinterConfig } from "./printing.server";

const log = getLogger("mes", "printing");

/**
 * Triggers an auto-print of a unit's label at one of two print points, when
 * the work center's printer assignment has auto-print enabled:
 *
 * - The first operation of the make method's routing (the unit was just
 *   minted) prints the unit label — unless the company's `travelerLabels`
 *   switch is on AND a traveler has printed for the job (a picking list with
 *   a line for the job has `travelersPrintedAt`), because that traveler
 *   already carries it. A job whose travelers never printed gets the label.
 * - The last operation of the top-level make method prints the finished-good
 *   label when the item's serial sequence has `printLabelOnCompletion` on.
 *
 * `shouldPrintOperationLabel` (`@carbon/database/travelers`) decides. "First"
 * and "last" come from the routing (`isFirstOperationOfMakeMethod`,
 * `isLastOperationOfMakeMethod`), the same answer the operation and assembly
 * views use — never from the unit's `Operation <id>` completion markers. A unit
 * completed at a later operation can carry one marker or none (the kanban scan
 * completes the next incomplete unit, which need not be one that passed the
 * first operation; a batch lot carries no markers at all), and counting them
 * reprinted a label at every later operation.
 *
 * Shared by every MES path that completes a tracked unit — the Complete
 * form (`x+/complete.tsx`), the QR/kanban scan (`x+/end.$operationId.tsx`)
 * and inspection lots (`services/quality.server.ts`) — so a label prints
 * however the operator completes it.
 */
export async function printOperationLabel({
  serviceRole,
  trackedEntityId,
  jobOperationId,
  jobMakeMethodId,
  workCenterId,
  companyId,
  userId
}: {
  serviceRole: SupabaseClient<Database>;
  trackedEntityId: string;
  jobOperationId: string;
  jobMakeMethodId: string | null;
  workCenterId: string | undefined;
  companyId: string;
  userId: string;
}) {
  try {
    if (!workCenterId || !jobMakeMethodId) return;
    // Most completions are neither first nor last: they read the routing only.
    const [isFirstOperation, isLastOperation] = await Promise.all([
      isFirstOperationOfMakeMethod(
        serviceRole,
        jobOperationId,
        jobMakeMethodId
      ),
      isLastOperationOfMakeMethod(
        serviceRole,
        companyId,
        jobOperationId,
        jobMakeMethodId
      )
    ]);
    if (!isFirstOperation && !isLastOperation) return;

    const [{ data: entity }, { data: makeMethod }, { data: settings }] =
      await Promise.all([
        serviceRole
          .from("trackedEntity")
          .select("id")
          .eq("id", trackedEntityId)
          .eq("companyId", companyId)
          .maybeSingle(),
        serviceRole
          .from("jobMakeMethod")
          .select("jobId, parentMaterialId, itemId")
          .eq("id", jobMakeMethodId)
          .eq("companyId", companyId)
          .maybeSingle(),
        // `travelerLabels` decides only the first-operation print.
        isFirstOperation
          ? serviceRole
              .from("companySettings")
              .select("travelerLabels")
              .eq("id", companyId)
              .maybeSingle()
          : { data: null }
      ]);
    // Service-role read: an entity outside the caller's company prints nothing.
    if (!entity || !makeMethod) return;

    const isTopLevelMakeMethod = makeMethod.parentMaterialId === null;
    const travelerLabels = settings?.travelerLabels ?? false;
    const [{ data: sequence }, travelerPrinted] = await Promise.all([
      // The finished-good label prints only at the last top-level operation.
      isLastOperation && isTopLevelMakeMethod
        ? serviceRole
            .from("itemSerialSequence")
            .select("printLabelOnCompletion")
            .eq("itemId", makeMethod.itemId)
            .eq("companyId", companyId)
            .maybeSingle()
        : { data: null },
      // Only a traveler that printed carries the unit label.
      isFirstOperation && travelerLabels
        ? hasJobTravelerPrinted(serviceRole, makeMethod.jobId, companyId)
        : false
    ]);

    const print = shouldPrintOperationLabel({
      isFirstOperation,
      isLastOperation,
      isTopLevelMakeMethod,
      travelerLabels,
      travelerPrinted,
      printLabelOnCompletion: !!sequence?.printLabelOnCompletion
    });
    if (!print) return;

    const { data: workCenter } = await serviceRole
      .from("workCenter")
      .select("locationId")
      .eq("id", workCenterId)
      .eq("companyId", companyId)
      .maybeSingle();
    const locationId = workCenter?.locationId ?? undefined;
    if (!locationId) return;

    const config = await getCachedPrinterConfig(
      serviceRole,
      companyId,
      locationId,
      "workCenter",
      workCenterId
    );
    if (config?.autoPrint ?? true) {
      await trigger("print-job", {
        sourceDocument: "Job",
        sourceDocumentId: trackedEntityId,
        companyId,
        userId,
        locationId,
        workCenterId
      });
    }
  } catch (e) {
    log.error("Auto-print failed", { companyId, trackedEntityId, error: e });
  }
}

/**
 * Has a traveler printed for this job: does a picking list with a line for
 * the job have `travelersPrintedAt` set? A failed read answers no, so the
 * unit label prints (a duplicate label is safer than none).
 */
async function hasJobTravelerPrinted(
  serviceRole: SupabaseClient<Database>,
  jobId: string,
  companyId: string
): Promise<boolean> {
  const { data, error } = await serviceRole
    .from("pickingListLine")
    .select("id, pickingList!inner(travelersPrintedAt)")
    .eq("jobId", jobId)
    .eq("companyId", companyId)
    .eq("pickingList.companyId", companyId)
    .not("pickingList.travelersPrintedAt", "is", null)
    .limit(1);
  if (error) {
    log.error("Traveler print lookup failed", { companyId, jobId, error });
    return false;
  }
  return (data ?? []).length > 0;
}
