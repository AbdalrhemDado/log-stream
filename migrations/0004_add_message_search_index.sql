CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX logs_message_trgm_idx
  ON logstream.logs USING gist (message gist_trgm_ops(siglen = 64));
