// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { respond } from "@carbon/api/carbon.server";
import { error, notFound } from "@carbon/auth";
import { authorize } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validator } from "@carbon/form";
import { getLogger } from "@carbon/logger";
import { redirect } from "@carbon/utils";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction
} from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { zfd } from "zod-form-data";
import {
  getMachineTimeOperationCandidates,
  getUnattributedMachineCount,
  getUnattributedMachineCountNeighbors
} from "~/modules/production/production.service";
import { parseMachineCountListFilters } from "~/modules/production/ui/MachineCounts/machine-count-filters.ee";
import MachineCountDrawer from "~/modules/production/ui/MachineCounts/MachineCountDrawer.ee";
import {
  getCompanyTimeZone,
  getLocationTimeZone
} from "~/modules/shared/shared.service";
import { recordMeta } from "~/utils/meta";
import { getParams, path } from "~/utils/path";

const logger = getLogger("erp", "production", "machine-counts");

// `nextId` is where the review goes after the answer: the row below, else
// the row above, else (empty) the list.
const answerFields = {
  nextId: zfd.text(z.string().optional())
};

const assignMachineCountForm = z.object({
  intent: z.literal("assign"),
  jobOperationId: z.string().min(1, { message: "Operation is required" }),
  ...answerFields
});

const dismissMachineCountForm = z.object({
  intent: z.literal("dismiss"),
  ...answerFields
});

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  recordMeta(data?.machineCount?.workCenter?.name, "Machine Count");

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await authorize(request, {
    "production.unattributedTime": "View"
  });

  const { id } = params;
  if (!id) throw notFound("id not found");

  const machineCount = await getUnattributedMachineCount(client, id, companyId);
  if (machineCount.error) {
    logger.error("Failed to load machine count", {
      companyId,
      id,
      error: machineCount.error
    });
    throw redirect(
      `${path.to.unattributedMachineCounts}?${getParams(request)}`,
      await flash(
        request,
        error(machineCount.error, "Failed to load machine count")
      )
    );
  }
  if (!machineCount.data) {
    // Assigned or dismissed since the link was made.
    throw redirect(
      `${path.to.unattributedMachineCounts}?${getParams(request)}`,
      await flash(request, error(null, "That machine count is no longer open"))
    );
  }

  const { workCenterId, periodStart, workCenter } = machineCount.data;
  // `getLocationTimeZone` falls back to the company's itself; read the
  // company's directly only when there is no location.
  const timeZone = workCenter.locationId
    ? await getLocationTimeZone(client, workCenter.locationId, companyId)
    : await getCompanyTimeZone(client, companyId);

  // The queue walks the list's rows: the same search and filters, read from
  // the list's query string.
  const filters = parseMachineCountListFilters(
    new URL(request.url).searchParams
  );

  const [neighbors, candidates] = await Promise.all([
    getUnattributedMachineCountNeighbors(client, {
      companyId,
      id,
      periodStart,
      filters
    }),
    getMachineTimeOperationCandidates(client, {
      workCenterId,
      locationId: workCenter.locationId,
      companyId
    })
  ]);

  // A failed read leaves the drawer usable: the drawer says which part did
  // not load rather than showing it empty.
  if (neighbors.error) {
    logger.error("Failed to load the machine count queue", {
      companyId,
      id,
      error: neighbors.error
    });
  }
  if (candidates.error) {
    logger.error("Failed to load the machine count operation candidates", {
      companyId,
      id,
      error: candidates.error
    });
  }

  return {
    machineCount: machineCount.data,
    timeZone,
    queue: neighbors.data ?? {
      position: null,
      total: 0,
      previousId: null,
      nextId: null
    },
    operationOptions: candidates.data ?? [],
    loadErrors: {
      queue: Boolean(neighbors.error),
      operations: Boolean(candidates.error)
    }
  };
}

export async function action(args: ActionFunctionArgs) {
  const { id } = args.params;
  if (!id) throw notFound("id not found");

  // Answered: on to the next row, with the list's filters. Refused: back to
  // this row, with the reason.
  const query = getParams(args.request);
  const answer = (
    result: Parameters<typeof respond>[1],
    nextId: string | undefined,
    message: string
  ) =>
    respond(args.request, result).redirect(
      nextId
        ? `${path.to.unattributedMachineCount(nextId)}?${query}`
        : `${path.to.unattributedMachineCounts}?${query}`,
      {
        message,
        onError: `${path.to.unattributedMachineCount(id)}?${query}`
      }
    );

  const intent = (await args.request.clone().formData()).get("intent");

  if (intent === "assign") {
    const input = await validator(assignMachineCountForm).request(args);
    if ("invalid" in input) return input.invalid;
    const { api } = await authorize(args.request);
    const result = await api.production.assignUnattributedMachineCount({
      unattributedMachineCountId: id,
      jobOperationId: input.data.jobOperationId
    });
    return answer(
      result,
      input.data.nextId,
      `Assigned to ${result.data?.jobId ?? "the job"}`
    );
  }

  const input = await validator(dismissMachineCountForm).request(args);
  if ("invalid" in input) return input.invalid;
  const { api } = await authorize(args.request);
  return answer(
    await api.production.dismissUnattributedMachineCount({
      unattributedMachineCountId: id
    }),
    input.data.nextId,
    "Dismissed"
  );
}

export default function MachineCountDetailRoute() {
  const { machineCount, timeZone, queue, operationOptions, loadErrors } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  // The drawer's query string is the list's search and filters.
  const [searchParams] = useSearchParams();

  return (
    <MachineCountDrawer
      key={machineCount.id}
      machineCount={machineCount}
      timeZone={timeZone}
      queue={queue}
      operationOptions={operationOptions}
      loadErrors={loadErrors}
      // Back to the list, with its filters. Not history back: the queue's
      // moves replace the entry, and the drawer may be the first page.
      onClose={() =>
        navigate(`${path.to.unattributedMachineCounts}?${searchParams}`)
      }
    />
  );
}
