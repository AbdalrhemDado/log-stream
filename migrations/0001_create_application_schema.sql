CREATE SCHEMA logstream AUTHORIZATION logstream_owner;

REVOKE ALL ON SCHEMA logstream FROM PUBLIC;
GRANT USAGE ON SCHEMA logstream TO logstream_runtime;
