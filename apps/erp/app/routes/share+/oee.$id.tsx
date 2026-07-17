import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { OeeShiftBoard, useInterval } from "@carbon/react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { getWorkCenterHourlyOee } from "~/modules/production/production.server";
import { getExternalLink } from "~/modules/shared";
import { ErrorMessage } from "./quote.$id";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  return [
    {
      title: data?.board ? `OEE — ${data.board.workCenter.name}` : "OEE Board"
    }
  ];
};

/**
 * Public, unauthenticated OEE TV board — resolved via an externalLink token
 * (documentType 'WorkCenter'), same pattern as the quote/SCAR share pages.
 * Polls every 60s; no realtime channel (no authenticated client here).
 */
export async function loader({ params }: LoaderFunctionArgs) {
  const { id } = params;
  if (!id) {
    return { board: null };
  }

  const serviceRole = getCarbonServiceRole();
  const externalLink = await getExternalLink(serviceRole, id);
  if (
    !externalLink.data ||
    (externalLink.data.documentType as string) !== "WorkCenter" ||
    !externalLink.data.documentId
  ) {
    return { board: null };
  }

  const result = await getWorkCenterHourlyOee(serviceRole, {
    workCenterId: externalLink.data.documentId,
    companyId: externalLink.data.companyId
  });

  return { board: result.data };
}

const REFRESH_INTERVAL_MS = 60_000;

export default function PublicOeeBoardRoute() {
  const { board } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  useInterval(() => {
    revalidator.revalidate();
  }, REFRESH_INTERVAL_MS);

  if (!board) {
    return (
      <ErrorMessage
        title="Board not found"
        message="This OEE board link is invalid or has been removed."
      />
    );
  }

  return (
    <div className="flex flex-col w-full min-h-screen p-4 overflow-y-auto">
      <OeeShiftBoard
        workCenterName={board.workCenter.name}
        status={board.status}
        shiftName={board.shift.name}
        window={board.window}
        timezone={board.timezone}
        currentJobs={board.currentJobs}
        cycleTimeMs={board.cycleTimeMs}
        refreshIntervalMs={REFRESH_INTERVAL_MS}
        hours={board.hours}
        totals={board.totals}
      />
    </div>
  );
}
