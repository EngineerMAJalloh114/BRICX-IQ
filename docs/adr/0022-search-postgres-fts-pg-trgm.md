# 0022. Search: Postgres full-text search + pg_trgm; Meilisearch only in Release 3

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C22

## Context

Stack v1 said "Postgres FTS first". Supplier and material names need fuzzy matching, and a separate search engine should only arrive with an explicit trigger.

## Decision

Keep **Postgres full-text search**; add **pg_trgm** for fuzzy supplier and material names. Add **Meilisearch** only in Release 3 (P23).

## Consequences

Positive:
- Unchanged direction from v1.
- An explicit trigger (Release 3) for adding a search engine.

Negative:
- Postgres FTS has weaker relevance ranking and multi-language stemming than a dedicated engine, which matters for a multi-language product. (proposed — needs review)
- Trigram indexes add storage and write cost on large tables. (proposed — needs review)
- Moving to Meilisearch in Release 3 needs a separate tenant-isolation model (tenant tokens) and an indexing pipeline. (proposed — needs review)

## Alternatives rejected

- **A dedicated search engine from the start**: not needed before Release 3.
