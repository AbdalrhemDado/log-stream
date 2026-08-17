CREATE TABLE logstream.log_minute_aggregates (
  bucket_start timestamp with time zone NOT NULL,
  service text NOT NULL,
  level text NOT NULL,
  count bigint NOT NULL,
  CONSTRAINT log_minute_aggregates_level_check CHECK (level IN ('debug', 'info', 'warn', 'error')),
  CONSTRAINT log_minute_aggregates_service_nonempty_check CHECK (char_length(service) > 0),
  CONSTRAINT log_minute_aggregates_count_positive_check CHECK (count >= 0),
  CONSTRAINT log_minute_aggregates_pkey PRIMARY KEY (bucket_start, service, level)
);

ALTER TABLE logstream.log_minute_aggregates OWNER TO logstream_owner;
REVOKE ALL ON TABLE logstream.log_minute_aggregates FROM PUBLIC;
REVOKE ALL ON TABLE logstream.log_minute_aggregates FROM logstream_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE logstream.log_minute_aggregates TO logstream_runtime;

CREATE INDEX log_minute_aggregates_bucket_start_idx
  ON logstream.log_minute_aggregates (bucket_start);

CREATE INDEX log_minute_aggregates_service_bucket_start_idx
  ON logstream.log_minute_aggregates (service, bucket_start);

CREATE INDEX log_minute_aggregates_level_bucket_start_idx
  ON logstream.log_minute_aggregates (level, bucket_start);
