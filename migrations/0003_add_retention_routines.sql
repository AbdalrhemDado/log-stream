CREATE FUNCTION logstream.ensure_log_partition(p_start timestamp with time zone)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_statement_time timestamp with time zone := pg_catalog.statement_timestamp();
  v_database_utc_day timestamp with time zone;
  v_end timestamp with time zone;
  v_partition_name text;
  v_constraint_name text;
  v_relation_oid oid;
  v_is_expected_child boolean := false;
  v_bound text;
  v_bound_parts text[];
BEGIN
  v_database_utc_day :=
    pg_catalog.date_trunc('day', v_statement_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  IF p_start IS NULL
    OR NOT pg_catalog.isfinite(p_start)
    OR p_start < v_database_utc_day - INTERVAL '1 day'
    OR p_start > v_database_utc_day + INTERVAL '2 days'
    OR p_start <>
      pg_catalog.date_trunc('day', p_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  THEN
    RAISE EXCEPTION 'Retention partition start is invalid.';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(1815642963, 2) THEN
    RAISE EXCEPTION 'Retention maintenance lock is unavailable.';
  END IF;

  v_end := p_start + INTERVAL '1 day';
  v_partition_name := 'logs_' || pg_catalog.to_char(
    p_start AT TIME ZONE 'UTC',
    'YYYYMMDD'
  );
  v_constraint_name := v_partition_name || '_timestamp_bounds';
  v_relation_oid := pg_catalog.to_regclass(
    pg_catalog.format('logstream.%I', v_partition_name)
  );

  IF v_relation_oid IS NOT NULL THEN
    SELECT pg_catalog.pg_get_expr(child.relpartbound, child.oid)
    INTO v_bound
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
    JOIN pg_catalog.pg_namespace AS parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
    JOIN pg_catalog.pg_namespace AS child_namespace
      ON child_namespace.oid = child.relnamespace
    WHERE parent_namespace.nspname = 'logstream'
      AND parent.relname = 'logs'
      AND child_namespace.nspname = 'logstream'
      AND child.relname = v_partition_name
      AND child.oid = v_relation_oid
      AND child.relispartition
      AND child.relkind = 'r'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_inherits AS child_inheritance
        WHERE child_inheritance.inhparent = child.oid
      );

    IF v_bound IS NOT NULL THEN
      v_bound_parts := pg_catalog.regexp_match(
        v_bound,
        '^FOR VALUES FROM \(''([^'']+)''\) TO \(''([^'']+)''\)$'
      );

      BEGIN
        v_is_expected_child :=
          v_bound_parts IS NOT NULL
          AND pg_catalog.array_length(v_bound_parts, 1) = 2
          AND v_bound_parts[1]::timestamp with time zone = p_start
          AND v_bound_parts[2]::timestamp with time zone = v_end;
      EXCEPTION
        WHEN OTHERS THEN
          v_is_expected_child := false;
      END;
    END IF;

    IF v_is_expected_child THEN
      RETURN false;
    END IF;

    RAISE EXCEPTION 'Retention partition relation is invalid.';
  END IF;

  BEGIN
    LOCK TABLE logstream.logs_default IN ACCESS EXCLUSIVE MODE;

    v_relation_oid := pg_catalog.to_regclass(
      pg_catalog.format('logstream.%I', v_partition_name)
    );
    IF v_relation_oid IS NOT NULL THEN
      RAISE EXCEPTION 'Retention partition relation is invalid.';
    END IF;

    EXECUTE pg_catalog.format(
      'CREATE TABLE logstream.%I (LIKE logstream.logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
      v_partition_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE logstream.%I OWNER TO logstream_owner',
      v_partition_name
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE logstream.%I ADD CONSTRAINT %I CHECK (timestamp >= %L::timestamp with time zone AND timestamp < %L::timestamp with time zone) NOT VALID',
      v_partition_name,
      v_constraint_name,
      p_start,
      v_end
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE logstream.%I VALIDATE CONSTRAINT %I',
      v_partition_name,
      v_constraint_name
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE logstream.%I FROM PUBLIC',
      v_partition_name
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE logstream.%I FROM logstream_runtime',
      v_partition_name
    );
    EXECUTE pg_catalog.format(
      'WITH moved_rows AS (
         DELETE FROM logstream.logs_default
         WHERE timestamp >= $1 AND timestamp < $2
         RETURNING timestamp, id, level, service, message, attributes, attributes_search, created_at
       )
       INSERT INTO logstream.%I
         (timestamp, id, level, service, message, attributes, attributes_search, created_at)
       SELECT timestamp, id, level, service, message, attributes, attributes_search, created_at
       FROM moved_rows',
      v_partition_name
    ) USING p_start, v_end;
    EXECUTE pg_catalog.format(
      'ALTER TABLE logstream.logs ATTACH PARTITION logstream.%I FOR VALUES FROM (%L) TO (%L)',
      v_partition_name,
      p_start,
      v_end
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'Retention partition relation is invalid.';
  END;

  RETURN true;
END
$$;

ALTER FUNCTION logstream.ensure_log_partition(timestamp with time zone)
  OWNER TO logstream_owner;
REVOKE ALL ON FUNCTION logstream.ensure_log_partition(timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logstream.ensure_log_partition(timestamp with time zone)
  TO logstream_runtime;

CREATE FUNCTION logstream.drop_one_expired_log_partition(p_cutoff timestamp with time zone)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_statement_time timestamp with time zone := pg_catalog.statement_timestamp();
  v_candidate record;
  v_name_date date;
  v_expected_start timestamp with time zone;
  v_expected_end timestamp with time zone;
  v_bound_parts text[];
  v_selected_name text;
  v_selected_end timestamp with time zone;
BEGIN
  IF p_cutoff IS NULL
    OR NOT pg_catalog.isfinite(p_cutoff)
    OR p_cutoff < v_statement_time - INTERVAL '3651 days'
    OR p_cutoff > v_statement_time
  THEN
    RAISE EXCEPTION 'Retention cutoff is invalid.';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(1815642963, 2) THEN
    RAISE EXCEPTION 'Retention maintenance lock is unavailable.';
  END IF;

  FOR v_candidate IN
    SELECT
      child.relname AS name,
      pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS bound
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
    JOIN pg_catalog.pg_namespace AS parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
    JOIN pg_catalog.pg_namespace AS child_namespace
      ON child_namespace.oid = child.relnamespace
    WHERE parent_namespace.nspname = 'logstream'
      AND parent.relname = 'logs'
      AND child_namespace.nspname = 'logstream'
      AND child.relname ~ '^logs_[0-9]{8}$'
      AND child.relispartition
      AND child.relkind = 'r'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_inherits AS child_inheritance
        WHERE child_inheritance.inhparent = child.oid
      )
    ORDER BY child.relname
  LOOP
    BEGIN
      v_name_date := pg_catalog.to_date(
        pg_catalog.substr(v_candidate.name, 6, 8),
        'YYYYMMDD'
      );
      IF pg_catalog.to_char(v_name_date, 'YYYYMMDD') <>
        pg_catalog.substr(v_candidate.name, 6, 8)
      THEN
        CONTINUE;
      END IF;

      v_expected_start := v_name_date::timestamp AT TIME ZONE 'UTC';
      v_expected_end := v_expected_start + INTERVAL '1 day';
      v_bound_parts := pg_catalog.regexp_match(
        v_candidate.bound,
        '^FOR VALUES FROM \(''([^'']+)''\) TO \(''([^'']+)''\)$'
      );

      IF v_bound_parts IS NULL
        OR pg_catalog.array_length(v_bound_parts, 1) <> 2
        OR v_bound_parts[1]::timestamp with time zone <> v_expected_start
        OR v_bound_parts[2]::timestamp with time zone <> v_expected_end
      THEN
        CONTINUE;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        CONTINUE;
    END;

    IF v_expected_end <= p_cutoff
      AND (v_selected_end IS NULL OR v_expected_end < v_selected_end)
    THEN
      v_selected_name := v_candidate.name;
      v_selected_end := v_expected_end;
    END IF;
  END LOOP;

  IF v_selected_name IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    EXECUTE pg_catalog.format('DROP TABLE logstream.%I', v_selected_name);
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'Retention partition relation is invalid.';
  END;
  RETURN true;
END
$$;

ALTER FUNCTION logstream.drop_one_expired_log_partition(timestamp with time zone)
  OWNER TO logstream_owner;
REVOKE ALL ON FUNCTION logstream.drop_one_expired_log_partition(timestamp with time zone)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logstream.drop_one_expired_log_partition(timestamp with time zone)
  TO logstream_runtime;

CREATE FUNCTION logstream.delete_expired_default_logs(
  p_cutoff timestamp with time zone,
  p_batch_size integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_statement_time timestamp with time zone := pg_catalog.statement_timestamp();
  v_deleted integer;
BEGIN
  IF p_cutoff IS NULL
    OR NOT pg_catalog.isfinite(p_cutoff)
    OR p_cutoff < v_statement_time - INTERVAL '3651 days'
    OR p_cutoff > v_statement_time
  THEN
    RAISE EXCEPTION 'Retention cutoff is invalid.';
  END IF;

  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'Retention batch size is invalid.';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(1815642963, 2) THEN
    RAISE EXCEPTION 'Retention maintenance lock is unavailable.';
  END IF;

  BEGIN
    WITH victims AS (
      SELECT default_logs.ctid
      FROM logstream.logs_default AS default_logs
      WHERE default_logs.timestamp < p_cutoff
      ORDER BY default_logs.timestamp, default_logs.id
      FOR UPDATE SKIP LOCKED
      LIMIT p_batch_size
    ),
    deleted AS (
      DELETE FROM logstream.logs_default AS default_logs
      USING victims
      WHERE default_logs.ctid = victims.ctid
      RETURNING 1
    )
    SELECT pg_catalog.count(*)::integer
    INTO v_deleted
    FROM deleted;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'Retention maintenance operation failed.';
  END;

  RETURN v_deleted;
END
$$;

ALTER FUNCTION logstream.delete_expired_default_logs(timestamp with time zone, integer)
  OWNER TO logstream_owner;
REVOKE ALL ON FUNCTION logstream.delete_expired_default_logs(timestamp with time zone, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logstream.delete_expired_default_logs(timestamp with time zone, integer)
  TO logstream_runtime;
