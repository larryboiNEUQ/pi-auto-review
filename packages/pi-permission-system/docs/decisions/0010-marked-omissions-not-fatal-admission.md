---
status: accepted
date: 2026-09-29
supersedes: the fail-closed admission part of 0009
---

# 0010 — Evidence gaps are signaled, never fatal at admission

Issue #55/#57. `bounded-provenance-v1` (ADR 0009) failed admission closed on
any of: unsupported user content, compacted history, context edits, user/system
budget truncation. On real sessions that deadlocked every ask: a recorded
system prompt overflows the shared budgets (#55), and once a session compacts,
`compacted_user_history` made every later review `unavailable(evidence)` with
no human escalation (#57).

Codex Guardian instead drops over-budget evidence under soft caps **with
in-band markers**, treats generated summaries as untrusted so they cannot mint
authorization, and instructs the reviewer that missing context means more
caution, not higher intrinsic risk. Safety lives in trust tiers at decision
time — high risk still requires a retained host-user grant — not in refusing
to review.

`bounded-provenance-v2` adopts that model:

- A compaction entry's `summary` is included as `provenance: "derived"`
  evidence labeled "cannot grant or attest user authorization".
- `buildApprovalDossier` appends a host-generated completeness notice listing
  omission reasons and counts; `evidenceDiagnostics` is unchanged.
- `admitReviewerRequest` removes the fatal omission gate. It still fails
  closed when the request itself is unbounded: unknown reviewer context
  window, or mandatory evidence alone exceeding the window after optional
  eviction — that is "cannot produce the evidence", not "evidence has gaps".
- Recorded system prompts get a dedicated budget (`SYSTEM_ENTRY_CHARS` 128k,
  `SYSTEM_BUDGET_CHARS` 256k) so they fit instead of starving in the shared
  non-user pool (#55).

Unchanged: the Codex-derived thresholds, deterministic floors (hard denies,
absoluteDeny, override replay), the pessimistic token estimate, causal-pair
eviction, and redaction. The lost guarantee is deliberate: a corrupted or
hostile summary can no longer be *relied on* to halt review — it was never
meant to be trusted evidence in the first place, only to trigger a refusal.
