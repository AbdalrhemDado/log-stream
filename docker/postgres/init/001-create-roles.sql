-- Local-development bootstrap only. Production deployments must supply managed credentials.
CREATE ROLE logstream_owner
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  PASSWORD 'local_owner_password';

CREATE ROLE logstream_runtime
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  PASSWORD 'local_runtime_password';

GRANT CONNECT ON DATABASE logstream TO logstream_owner, logstream_runtime;
GRANT CREATE ON DATABASE logstream TO logstream_owner;

ALTER ROLE logstream_owner SET timezone TO 'UTC';
ALTER ROLE logstream_runtime SET timezone TO 'UTC';
