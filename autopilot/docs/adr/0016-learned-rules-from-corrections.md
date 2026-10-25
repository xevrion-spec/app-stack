# ADR 0016: Learned categorisation rules come from recorded corrections, applied by an owner

Status: Accepted (2026-10-25)

## Context
Users correct categories. Silent auto-learning risks miscategorising (and mis-claiming) at scale.

## Decision
Every manual categorisation writes a `category_corrections` row in the same batch as the journal. Rules are computed on demand
(`learnRules`: half-life decay, minimum evidence 2, confidence ≥ 0.75), shown as suggestions, and only become `category_rules`
(`source='learned'`, priority 20, above global keywords) when an owner calls `POST /v1/books/rules/learn`. The call is audited.
A suggestion is hidden only if an identical pattern→category rule exists. Correcting away from an existing rule is the signal we want.

## Consequences
Explainable, reversible (delete the rule), and tenant-scoped. Auto-apply could be a later per-tenant setting.
