import { getCarbonServiceRole } from "@carbon/auth/client.server";
import {
  auditConfig,
  getCreateFields,
  getEntityConfigsForTable,
  isAuditableTable,
  isChildTable,
  isExtensionTable,
  isIndirectTable,
  isRootTable
} from "@carbon/database/audit.config";
import type {
  AuditDiff,
  CreateAuditLogEntry
} from "@carbon/database/audit.types";
import { groupBy } from "@carbon/utils";
import { z } from "zod";
import { inngest } from "../../client";

const AuditRecordSchema = z.object({
  event: z.object({
    table: z.string(),
    operation: z.enum(["INSERT", "UPDATE", "DELETE", "TRUNCATE"]),
    recordId: z.string(),
    new: z.record(z.any()).nullable(),
    old: z.record(z.any()).nullable(),
    timestamp: z.string()
  }),
  companyId: z.string(),
  actorId: z.string().nullish(),
  handlerConfig: z.record(z.any())
});

const AuditPayloadSchema = z.object({
  records: z.array(AuditRecordSchema)
});

export type AuditPayload = z.infer<typeof AuditPayloadSchema>;

/**
 * Compute the diff between old and new record values.
 */
function computeDiff(
  old: Record<string, unknown>,
  newRecord: Record<string, unknown>
): AuditDiff | null {
  const diff: AuditDiff = {};
  const skipFields = auditConfig.skipFields;

  const allKeys = new Set([...Object.keys(old), ...Object.keys(newRecord)]);

  for (const key of allKeys) {
    if ((skipFields as readonly string[]).includes(key)) continue;

    const oldValue = old[key];
    const newValue = newRecord[key];

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      if (
        typeof oldValue === "object" &&
        oldValue !== null &&
        typeof newValue === "object" &&
        newValue !== null &&
        !Array.isArray(oldValue) &&
        !Array.isArray(newValue)
      ) {
        const nestedDiff = computeNestedDiff(
          oldValue as Record<string, unknown>,
          newValue as Record<string, unknown>,
          key
        );
        Object.assign(diff, nestedDiff);
      } else {
        diff[key] = { old: oldValue, new: newValue };
      }
    }
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Build a diff for INSERT events from an allowlist of columns.
 * Returns null when no fields are configured or none are present on the record.
 */
function computeCreateDiff(
  newRecord: Record<string, unknown>,
  createFields: readonly string[]
): AuditDiff | null {
  if (createFields.length === 0) return null;

  const diff: AuditDiff = {};
  for (const field of createFields) {
    if (field in newRecord) {
      diff[field] = { new: newRecord[field] };
    }
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

function computeNestedDiff(
  old: Record<string, unknown>,
  newRecord: Record<string, unknown>,
  prefix: string
): AuditDiff {
  const diff: AuditDiff = {};

  const allKeys = new Set([...Object.keys(old), ...Object.keys(newRecord)]);

  for (const key of allKeys) {
    const oldValue = old[key];
    const newValue = newRecord[key];

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diff[`${prefix}.${key}`] = { old: oldValue, new: newValue };
    }
  }

  return diff;
}

type AuditRpcClient = {
  rpc(
    fn: "insert_audit_log_batch",
    params: { p_company_id: string; p_entries: object[] }
  ): Promise<{ data: number | null; error: any }>;
};

export const auditFunction = inngest.createFunction(
  {
    id: "event-handler-audit",
    retries: 3
  },
  { event: "carbon/event-audit" },
  async ({ event, step }) => {
    const payload = AuditPayloadSchema.parse(event.data);

    console.log(`Processing ${payload.records.length} audit log events`);

    const results = {
      inserted: 0,
      skipped: 0,
      failed: 0
    };

    const client = getCarbonServiceRole();

    type AuditRecord = (typeof payload.records)[number];
    const byCompany = groupBy(payload.records, (r) => r.companyId);

    for (const [companyId, records] of Object.entries(byCompany) as [
      string,
      AuditRecord[]
    ][]) {
      if (!companyId || companyId === "undefined") {
        console.log(`Skipping ${records.length} records: missing companyId`);
        results.skipped += records.length;
        continue;
      }

      const companyResult = await step.run(`audit-${companyId}`, async () => {
        const stepResults = { inserted: 0, skipped: 0, failed: 0 };

        // Check if company has audit logs enabled
        const { data: company } = await client
          .from("company")
          .select("auditLogEnabled")
          .eq("id", companyId)
          .single();

        if (
          !(company as { auditLogEnabled: boolean } | null)?.auditLogEnabled
        ) {
          console.log(
            `Skipping ${records.length} records: audit logging disabled for company ${companyId}`
          );
          stepResults.skipped += records.length;
          return stepResults;
        }

        const entries: CreateAuditLogEntry[] = [];

        for (const record of records) {
          const tableName = record.event.table;

          if (!isAuditableTable(tableName)) {
            console.log(`Skipping: table "${tableName}" is not auditable`);
            stepResults.skipped++;
            continue;
          }

          if (record.event.operation === "TRUNCATE") {
            console.log(
              `Skipping: TRUNCATE on "${tableName}" is not meaningful`
            );
            stepResults.skipped++;
            continue;
          }

          try {
            const actorId =
              record.actorId ??
              record.event.new?.updatedBy ??
              record.event.new?.createdBy ??
              record.event.old?.updatedBy ??
              record.event.old?.createdBy;

            let diff: AuditDiff | null = null;
            if (
              record.event.operation === "UPDATE" &&
              record.event.old &&
              record.event.new
            ) {
              diff = computeDiff(
                record.event.old as Record<string, unknown>,
                record.event.new as Record<string, unknown>
              );

              if (!diff) {
                console.log(
                  `Skipping: no meaningful diff for UPDATE on "${tableName}" record ${record.event.recordId}`
                );
                stepResults.skipped++;
                continue;
              }
            }

            const operation = record.event
              .operation as CreateAuditLogEntry["operation"];
            const entryActorId = (actorId as string) ?? null;
            const entryMetadata = record.handlerConfig.metadata ?? null;

            const entityConfigs = getEntityConfigsForTable(tableName);

            if (entityConfigs.length === 0) {
              console.log(
                `Skipping: no entity config found for table "${tableName}"`
              );
              stepResults.skipped++;
              continue;
            }

            let entriesCreatedForRecord = 0;

            for (const entityEntry of entityConfigs) {
              const { entityType, tableConfig } = entityEntry;

              if (
                record.event.operation === "INSERT" &&
                !isRootTable(tableConfig)
              ) {
                console.log(
                  `Skipping: INSERT on non-root table "${tableName}" for entity "${entityType}"`
                );
                continue;
              }

              const effectiveDiff =
                record.event.operation === "INSERT" && record.event.new
                  ? computeCreateDiff(
                      record.event.new as Record<string, unknown>,
                      getCreateFields(tableConfig)
                    )
                  : diff;

              if (isRootTable(tableConfig)) {
                entries.push({
                  tableName,
                  entityType,
                  entityId: record.event.recordId,
                  recordId: record.event.recordId,
                  operation,
                  actorId: entryActorId,
                  diff: effectiveDiff,
                  metadata: entryMetadata,
                  createdAt: record.event.timestamp
                });
                entriesCreatedForRecord++;
              } else if (isExtensionTable(tableConfig)) {
                entries.push({
                  tableName,
                  entityType,
                  entityId: record.event.recordId,
                  recordId: record.event.recordId,
                  operation,
                  actorId: entryActorId,
                  diff: effectiveDiff,
                  metadata: entryMetadata,
                  createdAt: record.event.timestamp
                });
                entriesCreatedForRecord++;
              } else if (isChildTable(tableConfig)) {
                const recordData = record.event.new ?? record.event.old;
                const entityId = recordData?.[tableConfig.entityIdColumn];

                if (!entityId) {
                  console.log(
                    `Skipping: could not resolve entity ID from column "${tableConfig.entityIdColumn}" for "${tableName}" record ${record.event.recordId}`
                  );
                  continue;
                }

                entries.push({
                  tableName,
                  entityType,
                  entityId: String(entityId),
                  recordId: record.event.recordId,
                  operation,
                  actorId: entryActorId,
                  diff: effectiveDiff,
                  metadata: entryMetadata,
                  createdAt: record.event.timestamp
                });
                entriesCreatedForRecord++;
              } else if (isIndirectTable(tableConfig)) {
                const { junction, fk, entityIdColumn } = tableConfig.resolve;

                const { data: junctionRow } = await client
                  .from(junction as any)
                  .select(entityIdColumn)
                  .eq(fk, record.event.recordId)
                  .limit(1)
                  .maybeSingle();

                const row = junctionRow as unknown as Record<
                  string,
                  unknown
                > | null;
                if (row && row[entityIdColumn]) {
                  entries.push({
                    tableName,
                    entityType,
                    entityId: String(row[entityIdColumn]),
                    recordId: record.event.recordId,
                    operation,
                    actorId: entryActorId,
                    diff: effectiveDiff,
                    metadata: entryMetadata
                  });
                  entriesCreatedForRecord++;
                } else {
                  console.log(
                    `Skipping: no parent entity found via junction "${junction}" for "${tableName}" record ${record.event.recordId} (entity: ${entityType})`
                  );
                }
              }
            }

            if (entriesCreatedForRecord === 0) {
              console.log(
                `Skipping: could not resolve any entity for "${tableName}" record ${record.event.recordId}`
              );
              stepResults.skipped++;
            }
          } catch (error) {
            console.error(`Failed to process audit record:`, {
              error,
              record
            });
            stepResults.failed++;
          }
        }

        // Batch insert entries using RPC
        if (entries.length > 0) {
          const { data: insertedCount, error } = await (
            client as unknown as AuditRpcClient
          ).rpc("insert_audit_log_batch", {
            p_company_id: companyId,
            p_entries: entries
          });

          if (error) {
            console.error(`Failed to insert audit log entries:`, { error });
            stepResults.failed += entries.length;
          } else {
            stepResults.inserted += insertedCount ?? entries.length;
          }
        }

        return stepResults;
      });

      results.inserted += companyResult.inserted;
      results.skipped += companyResult.skipped;
      results.failed += companyResult.failed;
    }

    console.log("Audit function completed", results);

    return results;
  }
);
