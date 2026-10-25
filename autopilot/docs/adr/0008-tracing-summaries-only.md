# ADR 0008: Langfuse tracing with summaries only
Status: accepted (2026-10-25)

`packages/pipeline/src/tracing.ts` sends traces to Langfuse's public ingestion API using fetch (no SDK; works in Workers). The pipeline traces each stage (categorise, reconcile, draft) plus a QA event and a `qa_score` score, carrying counts, methods and reason codes only, never bank descriptions or amounts. Tracing is off unless `LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY` are set, and export failures never fail a job.
