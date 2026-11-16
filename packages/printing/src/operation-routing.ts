// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// Browser-safe routing reads: the MES operation service, which client code
// also imports, and the label print in `./operation-label.server` share them.

import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Is this the first operation of its make method's routing? A serial unit only
 * earns a printed label when it is completed at its first operation, so this
 * decides both the label auto-print and how the operation views pick units.
 *
 * "First" means no jobOperationDependency whose predecessor shares this op's
 * jobMakeMethodId. Cross make-method (subassembly) dependencies are ignored: a
 * parent-assembly op still has no printed label just because a subassembly
 * finished first. `order` is only a display/sort field, not a precedence signal.
 *
 * Fails closed: an errored lookup reads as "not first" — no auto-select, no
 * label — which is the safe default when we can't confirm there's no predecessor.
 */
export async function isFirstOperationOfMakeMethod(
  client: SupabaseClient<Database>,
  operationId: string,
  jobMakeMethodId: string
): Promise<boolean> {
  const priorDependency = await client
    .from("jobOperationDependency")
    .select(
      "dependsOn:jobOperation!jobOperationDependency_dependsOnId_fk!inner(jobMakeMethodId)"
    )
    .eq("operationId", operationId)
    .eq("dependsOn.jobMakeMethodId", jobMakeMethodId)
    .limit(1)
    .maybeSingle();
  return !priorDependency.error && !priorDependency.data;
}

/**
 * Is this the last operation of its make method's routing? Mirrors
 * isFirstOperationOfMakeMethod: "last" means no operation of the same make
 * method depends on this one.
 *
 * Fails closed: an errored lookup reads as "not last".
 */
export async function isLastOperationOfMakeMethod(
  client: SupabaseClient<Database>,
  companyId: string,
  operationId: string,
  jobMakeMethodId: string
): Promise<boolean> {
  const nextDependency = await client
    .from("jobOperationDependency")
    .select(
      "operation:jobOperation!jobOperationDependency_operationId_fk!inner(jobMakeMethodId)"
    )
    .eq("dependsOnId", operationId)
    .eq("companyId", companyId)
    .eq("operation.jobMakeMethodId", jobMakeMethodId)
    .limit(1)
    .maybeSingle();
  return !nextDependency.error && !nextDependency.data;
}
