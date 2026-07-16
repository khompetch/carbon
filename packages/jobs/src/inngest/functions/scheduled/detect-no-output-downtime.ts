import { getCarbonServiceRole } from "@carbon/auth/client.server";
import type { OeeEventInput, OeeQuantityInput } from "@carbon/utils";
import { detectNoOutput, standardMsPerPiece } from "@carbon/utils";
import { inngest } from "../../client";

type OpenEventRow = {
  id: string;
  startTime: string;
  workCenterId: string;
  jobOperationId: string;
  employeeId: string | null;
  createdBy: string;
  laborTime: number | null;
  laborUnit: string | null;
  machineTime: number | null;
  machineUnit: string | null;
};

type OpenDowntimeRow = {
  id: string;
  workCenterId: string;
  startTime: string;
  isAuto: boolean;
};

/**
 * Auto no-output downtime detector. Every minute, for each company that has
 * configured companySettings.autoDowntimeMultiplier + autoDowntimeReasonId:
 *
 * - A work center with an open production event but no output logged within
 *   multiplier × cycle time gets an Unplanned workCenterDowntime row
 *   (isAuto = true) with the configured default reason, starting at the
 *   moment the threshold was crossed.
 * - Open auto rows are swept closed when output arrives or the event ends
 *   (safety net — the MES insert-quantity hooks close them immediately).
 *
 * Per-work-center override: workCenter.autoDowntimeMultiplier (NULL = inherit
 * company default, ≤ 0 = disabled for that work center). Operations without a
 * per-piece labor/machine standard are skipped (no cycle time to compare to).
 */
export const detectNoOutputDowntimeFunction = inngest.createFunction(
  { id: "detect-no-output-downtime", retries: 1 },
  { cron: "* * * * *" },
  async ({ step, logger }) => {
    // The auto-downtime columns are newer than the generated DB types
    const serviceRole = getCarbonServiceRole() as any;

    return await step.run("detect-no-output-downtime", async () => {
      const now = Date.now();

      const { data: companies, error: companiesError } = (await serviceRole
        .from("companySettings")
        .select("id, autoDowntimeMultiplier, autoDowntimeReasonId")
        .not("autoDowntimeMultiplier", "is", null)
        .not("autoDowntimeReasonId", "is", null)) as {
        data:
          | {
              id: string;
              autoDowntimeMultiplier: number;
              autoDowntimeReasonId: string;
            }[]
          | null;
        error: any;
      };

      if (companiesError) {
        logger.error("Failed to fetch company settings", {
          error: companiesError
        });
        return;
      }

      let started = 0;
      let closed = 0;

      for (const settings of companies ?? []) {
        const companyId = settings.id;
        try {
          const [openEvents, openDowntimes] = await Promise.all([
            serviceRole
              .from("productionEvent")
              .select(
                "id, startTime, workCenterId, jobOperationId, employeeId, createdBy, ...jobOperation(laborTime, laborUnit, machineTime, machineUnit)"
              )
              .eq("companyId", companyId)
              .is("endTime", null)
              .not("workCenterId", "is", null) as unknown as Promise<{
              data: OpenEventRow[] | null;
              error: any;
            }>,
            serviceRole
              .from("workCenterDowntime")
              .select("id, workCenterId, startTime, isAuto")
              .eq("companyId", companyId)
              .is("endTime", null) as unknown as Promise<{
              data: OpenDowntimeRow[] | null;
              error: any;
            }>
          ]);

          if (openEvents.error || openDowntimes.error) {
            logger.error("Failed to fetch open events/downtimes", {
              companyId,
              eventsError: openEvents.error,
              downtimesError: openDowntimes.error
            });
            continue;
          }

          const eventsByWorkCenter = new Map<string, OpenEventRow[]>();
          for (const event of openEvents.data ?? []) {
            const group = eventsByWorkCenter.get(event.workCenterId) ?? [];
            group.push(event);
            eventsByWorkCenter.set(event.workCenterId, group);
          }

          const openDowntimesByWorkCenter = new Map<
            string,
            OpenDowntimeRow[]
          >();
          for (const downtime of openDowntimes.data ?? []) {
            const group =
              openDowntimesByWorkCenter.get(downtime.workCenterId) ?? [];
            group.push(downtime);
            openDowntimesByWorkCenter.set(downtime.workCenterId, group);
          }

          // Per-WC multiplier overrides for every WC we might touch
          const workCenterIds = [
            ...new Set([
              ...eventsByWorkCenter.keys(),
              ...openDowntimesByWorkCenter.keys()
            ])
          ];
          if (workCenterIds.length === 0) continue;

          const { data: workCenters } = (await serviceRole
            .from("workCenter")
            .select("id, autoDowntimeMultiplier")
            .in("id", workCenterIds)) as {
            data:
              | { id: string; autoDowntimeMultiplier: number | null }[]
              | null;
            error: any;
          };
          const overrideByWorkCenter = new Map(
            (workCenters ?? []).map((row) => [
              row.id,
              row.autoDowntimeMultiplier
            ])
          );

          // Outputs logged against the open operations since the earliest
          // open event started — anything older can't move the baseline.
          const openOperationIds = [
            ...new Set(
              (openEvents.data ?? []).map((event) => event.jobOperationId)
            )
          ];
          let quantityRows: {
            jobOperationId: string;
            createdAt: string;
          }[] = [];
          if (openOperationIds.length > 0) {
            const earliestStart = (openEvents.data ?? [])
              .map((event) => event.startTime)
              .sort()[0]!;
            const { data } = (await serviceRole
              .from("productionQuantity")
              .select("jobOperationId, createdAt")
              .eq("companyId", companyId)
              .in("jobOperationId", openOperationIds)
              .gte("createdAt", earliestStart)) as {
              data: { jobOperationId: string; createdAt: string }[] | null;
              error: any;
            };
            quantityRows = data ?? [];
          }
          const quantitiesByOperation = new Map<string, OeeQuantityInput[]>();
          for (const row of quantityRows) {
            const group = quantitiesByOperation.get(row.jobOperationId) ?? [];
            group.push({
              createdAt: row.createdAt,
              type: "Production",
              quantity: 0,
              jobOperationId: row.jobOperationId
            });
            quantitiesByOperation.set(row.jobOperationId, group);
          }

          for (const [workCenterId, events] of eventsByWorkCenter) {
            const multiplier =
              overrideByWorkCenter.get(workCenterId) ??
              settings.autoDowntimeMultiplier;
            if (!multiplier || multiplier <= 0) continue;

            let msPerPiece = 0;
            for (const event of events) {
              msPerPiece = Math.max(
                msPerPiece,
                standardMsPerPiece(event.laborTime, event.laborUnit),
                standardMsPerPiece(event.machineTime, event.machineUnit)
              );
            }
            if (msPerPiece <= 0) continue;

            const oeeEvents: OeeEventInput[] = events.map((event) => ({
              startTime: event.startTime,
              endTime: null,
              type: null,
              jobOperationId: event.jobOperationId
            }));
            const quantities = events.flatMap(
              (event) => quantitiesByOperation.get(event.jobOperationId) ?? []
            );

            const crossedAt = detectNoOutput({
              events: oeeEvents,
              quantities,
              msPerPiece,
              multiplier,
              now
            });
            if (crossedAt === null) continue;

            // Already down (auto or manual)? Don't stack another record.
            if ((openDowntimesByWorkCenter.get(workCenterId) ?? []).length > 0)
              continue;

            const reporter =
              events.find((event) => event.employeeId)?.employeeId ??
              events[0]!.createdBy;

            const { error: insertError } = await serviceRole
              .from("workCenterDowntime")
              .insert({
                workCenterId,
                companyId,
                type: "Unplanned",
                downtimeReasonId: settings.autoDowntimeReasonId,
                isAuto: true,
                startTime: new Date(crossedAt).toISOString(),
                notes: `Auto: no output within ${multiplier}× cycle time`,
                createdBy: reporter
              });
            if (insertError) {
              logger.error("Failed to insert auto downtime", {
                companyId,
                workCenterId,
                error: insertError
              });
            } else {
              started++;
            }
          }

          // Sweep-close open AUTO rows: output arrived after the row started,
          // or there is no open event on the work center anymore.
          for (const [workCenterId, downtimes] of openDowntimesByWorkCenter) {
            const autoRows = downtimes.filter((row) => row.isAuto);
            if (autoRows.length === 0) continue;

            const events = eventsByWorkCenter.get(workCenterId) ?? [];
            let lastOutput: number | null = null;
            for (const event of events) {
              for (const quantity of quantitiesByOperation.get(
                event.jobOperationId
              ) ?? []) {
                const time = new Date(quantity.createdAt).getTime();
                if (!Number.isNaN(time) && (!lastOutput || time > lastOutput))
                  lastOutput = time;
              }
            }

            for (const row of autoRows) {
              let endTime: string | null = null;
              if (events.length === 0) {
                endTime = new Date(now).toISOString();
              } else if (
                lastOutput &&
                lastOutput > new Date(row.startTime).getTime()
              ) {
                endTime = new Date(lastOutput).toISOString();
              }
              if (!endTime) continue;

              const { error: updateError } = await serviceRole
                .from("workCenterDowntime")
                .update({ endTime, updatedAt: new Date(now).toISOString() })
                .eq("id", row.id)
                .eq("companyId", companyId)
                .is("endTime", null);
              if (updateError) {
                logger.error("Failed to close auto downtime", {
                  companyId,
                  downtimeId: row.id,
                  error: updateError
                });
              } else {
                closed++;
              }
            }
          }
        } catch (err) {
          logger.error("Error processing company", { companyId, error: err });
        }
      }

      if (started > 0 || closed > 0) {
        logger.info("Auto no-output downtime pass completed", {
          started,
          closed
        });
      }
      return { started, closed };
    });
  }
);
