CREATE INDEX logs_attributes_search_gin_idx
  ON logstream.logs USING gin (attributes_search jsonb_path_ops);

CREATE INDEX logs_level_timestamp_id_idx
  ON logstream.logs (level, timestamp DESC, id DESC);
