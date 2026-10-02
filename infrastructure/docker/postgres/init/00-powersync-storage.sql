-- P2-01 (ADR 0034): PowerSync's bucket storage lives in its own database,
-- separate from the application database it replicates from.
-- Runs once, on the first start of an empty postgres-data volume.
-- Roles, extensions and the `powersync` publication are P2-02's.
CREATE DATABASE powersync_storage;
