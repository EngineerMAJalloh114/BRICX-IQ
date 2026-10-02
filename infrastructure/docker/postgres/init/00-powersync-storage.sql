-- P2-01 (ADR 0034): PowerSync's bucket storage lives in its own database,
-- separate from the application database it replicates from.
-- Runs once, on the first start of an empty postgres-data volume.
-- 01-bootstrap.sh (P2-02, ADR 0035) gives it to powersync_storage_owner.
CREATE DATABASE powersync_storage;
