CREATE TABLE logstream.logs (
  timestamp timestamp with time zone NOT NULL,
  id uuid NOT NULL,
  level text NOT NULL,
  service text NOT NULL,
  message text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  attributes_search jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT logs_level_check CHECK (level IN ('debug', 'info', 'warn', 'error')),
  CONSTRAINT logs_service_nonempty_check CHECK (char_length(service) > 0),
  CONSTRAINT logs_message_nonempty_check CHECK (char_length(message) > 0),
  CONSTRAINT logs_attributes_object_check CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT logs_attributes_search_object_check CHECK (
    jsonb_typeof(attributes_search) = 'object'
  ),
  CONSTRAINT logs_pkey PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);

ALTER TABLE logstream.logs OWNER TO logstream_owner;
REVOKE ALL ON TABLE logstream.logs FROM PUBLIC;
REVOKE ALL ON TABLE logstream.logs FROM logstream_runtime;
GRANT SELECT, INSERT ON TABLE logstream.logs TO logstream_runtime;

CREATE TABLE logstream.logs_default PARTITION OF logstream.logs DEFAULT;
ALTER TABLE logstream.logs_default OWNER TO logstream_owner;
REVOKE ALL ON TABLE logstream.logs_default FROM PUBLIC;
REVOKE ALL ON TABLE logstream.logs_default FROM logstream_runtime;

CREATE INDEX logs_service_timestamp_id_idx
  ON logstream.logs (service, timestamp DESC, id DESC);
