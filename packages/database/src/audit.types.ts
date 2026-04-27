import type { AuditableTable, AuditEntityType } from "./audit.config";

/**
 * Operation types for audit log entries
 */
export type AuditOperation = "INSERT" | "UPDATE" | "DELETE";

/**
 * Metadata captured with each audit log entry
 */
export interface AuditMetadata {
  ipAddress?: string;
  userAgent?: string;
  origin?: "web" | "api" | "import" | "system";
  requestId?: string;
}

/**
 * Represents a single field change in the diff.
 *
 * Both `old` and `new` are optional: INSERT entries populated via a table's
 * `createFields` config only include `new`, and the UI hides the "old" pill
 * when the key is absent.
 */
export interface AuditDiffEntry {
  old?: unknown;
  new?: unknown;
}

/**
 * The diff object showing what changed
 * Keys are field names (can be nested like "customFields.myField")
 */
export type AuditDiff = Record<string, AuditDiffEntry>;

/**
 * A single audit log entry as stored in the database
 */
export interface AuditLogEntry {
  id: string;
  companyId: string;
  tableName: AuditableTable;
  entityType: AuditEntityType;
  entityId: string;
  /**
   * The raw PK of the row that triggered this entry.
   * For root tables, recordId == entityId. For child tables they differ
   * (e.g. entityId = parent id, recordId = child row id). Nullable to
   * tolerate legacy rows inserted before the column was added.
   */
  recordId: string | null;
  operation: AuditOperation;
  actorId: string | null;
  diff: AuditDiff | null;
  metadata: AuditMetadata | null;
  createdAt: string;
}

/**
 * Input for creating an audit log entry
 * Note: companyId is passed separately to the RPC function
 */
export interface CreateAuditLogEntry {
  tableName: AuditableTable;
  entityType: AuditEntityType;
  entityId: string;
  recordId: string;
  operation: AuditOperation;
  actorId: string | null;
  diff?: AuditDiff | null;
  metadata?: AuditMetadata | null;
  createdAt?: string;
}

/**
 * Filters for querying audit logs
 */
export interface AuditLogFilters {
  entityType?: AuditEntityType;
  actorId?: string;
  operation?: AuditOperation;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Response from getGlobalAuditLog with pagination info
 */
export interface AuditLogResponse {
  data: AuditLogEntry[];
  count: number;
}

/**
 * An archived audit log period
 */
export interface AuditLogArchive {
  id: string;
  companyId: string;
  archivePath: string;
  startDate: string;
  endDate: string;
  rowCount: number;
  sizeBytes: number | null;
  createdAt: string;
}

/**
 * Configuration for enabling audit logs
 */
export interface AuditLogConfig {
  enabled: boolean;
}
