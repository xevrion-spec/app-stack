# ADR 0014: Additive-only migrations with tested down scripts
Status: accepted (2026-10-25)

From 0002 on, migrations may only add tables, columns (nullable or with defaults), indexes, triggers and virtual tables. No `DROP`, `RENAME`, destructive `DELETE`, or `NOT NULL` columns without defaults. Each migration from 0003 has a `migrations-down/*.down.sql`. CI (`apps/api/test/reliability.test.ts`) checks numbering, the additive rules, that down scripts exist, that up → down → up yields an identical schema on SQLite, and that upgrading a database with existing data keeps it (e.g. backfilling the FTS index).
Why: Workers deploy gradually, so old and new code run against the same D1 for a while; additive changes keep both working. Destructive changes need an expand/contract sequence across two releases.
