Scaffold NestJS module `$ARGUMENTS` by copying apps/api/src/modules/_template.
Write the unit and integration tests first, then:
Create: schema (org_id, UUIDv7 id, timestamps, version), migration with enableTenantRls,
controller, service, repository using withTx, Zod DTOs, CASL @Can guards, audit calls,
outbox events, public-api.ts. Register in app.module.ts.
If the entity syncs: add to packages/sync-schema, the powersync publication, a stream scope, and the leak test.
