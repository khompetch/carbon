-- =============================================================================
-- Use real per-event timestamps for audit ordering
--
-- Two related changes so audit entries sort by the *actual* DB change time
-- rather than the (transaction-stable) batch write time:
--
--   1. dispatch_event_batch() switches NOW() -> clock_timestamp() inside the
--      event payload. clock_timestamp() reads the wall clock per call, so
--      every row in batched_new / batched_old gets a unique microsecond
--      timestamp even when emitted from one statement.
--
--   2. insert_audit_log_batch() now reads createdAt from each entry payload.
--      The audit handler (packages/jobs/.../audit.ts) passes event.timestamp
--      through, giving the audit row the *event's* time, not the time the
--      handler happened to write it. Falls back to clock_timestamp() when
--      omitted so legacy callers still get unique timestamps.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Update dispatch_event_batch to use clock_timestamp()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_event_batch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  sub RECORD;
  msg_batch JSONB[];
  rec_company_id TEXT;
  has_subs BOOLEAN;
  current_actor_id TEXT;
  pk_column TEXT;
  query_text TEXT;
BEGIN
  IF current_setting('app.sync_in_progress', true) = 'true' THEN
    RETURN NULL;
  END IF;

  current_actor_id := auth.uid()::TEXT;
  pk_column := public.get_primary_key_column(TG_TABLE_NAME);

  IF TG_OP = 'DELETE' THEN
    SELECT t."companyId" INTO rec_company_id FROM batched_old t LIMIT 1;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT t."companyId" INTO rec_company_id FROM batched_new t LIMIT 1;
  ELSE
    SELECT t."companyId" INTO rec_company_id FROM batched_new t LIMIT 1;
  END IF;

  IF rec_company_id IS NULL THEN RETURN NULL; END IF;

  SELECT EXISTS (
    SELECT 1 FROM "eventSystemSubscription"
    WHERE "table" = TG_TABLE_NAME
      AND "companyId" = rec_company_id
      AND "active" = TRUE
      AND TG_OP = ANY("operations")
  ) INTO has_subs;

  IF NOT has_subs THEN RETURN NULL; END IF;

  FOR sub IN
    SELECT * FROM "eventSystemSubscription"
    WHERE "table" = TG_TABLE_NAME
      AND "companyId" = rec_company_id
      AND "active" = TRUE
      AND TG_OP = ANY("operations")
  LOOP

    IF TG_OP = 'INSERT' THEN
        query_text := format('
            SELECT array_agg(
                jsonb_build_object(
                    ''subscriptionId'', $1,
                    ''triggerType'', $2,
                    ''handlerType'', $3,
                    ''handlerConfig'', $4,
                    ''companyId'', $5,
                    ''actorId'', $6,
                    ''event'', jsonb_build_object(
                        ''table'', $7,
                        ''operation'', $8,
                        ''recordId'', t.%I::TEXT,
                        ''new'', row_to_json(t)::jsonb,
                        ''old'', null,
                        ''timestamp'', clock_timestamp()
                    )
                )
            )
            FROM batched_new t
            WHERE t."companyId" = $5
              AND ($9 = ''{}''::jsonb OR row_to_json(t)::jsonb @> $9)
        ', pk_column);

        EXECUTE query_text INTO msg_batch
        USING sub.id, TG_LEVEL, sub."handlerType", sub."config", rec_company_id,
              current_actor_id, TG_TABLE_NAME, TG_OP, sub.filter;

    ELSIF TG_OP = 'DELETE' THEN
        query_text := format('
            SELECT array_agg(
                jsonb_build_object(
                    ''subscriptionId'', $1,
                    ''triggerType'', $2,
                    ''handlerType'', $3,
                    ''handlerConfig'', $4,
                    ''companyId'', $5,
                    ''actorId'', $6,
                    ''event'', jsonb_build_object(
                        ''table'', $7,
                        ''operation'', $8,
                        ''recordId'', t.%I::TEXT,
                        ''new'', null,
                        ''old'', row_to_json(t)::jsonb,
                        ''timestamp'', clock_timestamp()
                    )
                )
            )
            FROM batched_old t
            WHERE t."companyId" = $5
              AND ($9 = ''{}''::jsonb OR row_to_json(t)::jsonb @> $9)
        ', pk_column);

        EXECUTE query_text INTO msg_batch
        USING sub.id, TG_LEVEL, sub."handlerType", sub."config", rec_company_id,
              current_actor_id, TG_TABLE_NAME, TG_OP, sub.filter;

    ELSIF TG_OP = 'UPDATE' THEN
        query_text := format('
            SELECT array_agg(
                jsonb_build_object(
                    ''subscriptionId'', $1,
                    ''triggerType'', $2,
                    ''handlerType'', $3,
                    ''handlerConfig'', $4,
                    ''companyId'', $5,
                    ''actorId'', $6,
                    ''event'', jsonb_build_object(
                        ''table'', $7,
                        ''operation'', $8,
                        ''recordId'', n.%I::TEXT,
                        ''new'', row_to_json(n)::jsonb,
                        ''old'', row_to_json(o)::jsonb,
                        ''timestamp'', clock_timestamp()
                    )
                )
            )
            FROM batched_new n
            JOIN batched_old o ON n.%I = o.%I
            WHERE n."companyId" = $5
              AND ($9 = ''{}''::jsonb OR row_to_json(n)::jsonb @> $9)
        ', pk_column, pk_column, pk_column);

        EXECUTE query_text INTO msg_batch
        USING sub.id, TG_LEVEL, sub."handlerType", sub."config", rec_company_id,
              current_actor_id, TG_TABLE_NAME, TG_OP, sub.filter;
    END IF;

    IF msg_batch IS NOT NULL AND array_length(msg_batch, 1) > 0 THEN
      PERFORM pgmq.send_batch('event_system', msg_batch);
    END IF;

  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.dispatch_event_batch() IS 'Dispatches database events to PGMQ. Uses clock_timestamp() so each event has a unique microsecond timestamp even when batched.';

-- ----------------------------------------------------------------------------
-- 2. Update insert_audit_log_batch to honor a per-entry createdAt
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.insert_audit_log_batch(
  p_company_id TEXT,
  p_entries JSONB[]
)
RETURNS INTEGER AS $$
DECLARE
  tbl_name TEXT;
  entry JSONB;
  inserted_count INTEGER := 0;
  v_created_at TIMESTAMPTZ;
BEGIN
  tbl_name := 'auditLog_' || p_company_id;

  PERFORM create_audit_log_table(p_company_id);

  FOREACH entry IN ARRAY p_entries
  LOOP
    -- Use the entry's createdAt if provided (the original event time);
    -- otherwise fall back to clock_timestamp() so rows in the same
    -- transaction still get unique values rather than sharing NOW().
    v_created_at := COALESCE(
      (entry->>'createdAt')::TIMESTAMPTZ,
      clock_timestamp()
    );

    EXECUTE format('
      INSERT INTO %I ("tableName", "entityType", "entityId", "recordId", "operation", "actorId", "diff", "metadata", "createdAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ', tbl_name)
    USING
      entry->>'tableName',
      entry->>'entityType',
      entry->>'entityId',
      entry->>'recordId',
      entry->>'operation',
      entry->>'actorId',
      CASE WHEN entry->'diff' = 'null'::jsonb THEN NULL ELSE entry->'diff' END,
      CASE WHEN entry->'metadata' = 'null'::jsonb THEN NULL ELSE entry->'metadata' END,
      v_created_at;

    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN inserted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
