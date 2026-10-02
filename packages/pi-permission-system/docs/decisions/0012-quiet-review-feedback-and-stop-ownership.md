---
status: accepted
date: 2026-10-03
---

# 0012 — Quiet reviewer feedback and owning-agent stops

Daily use of the Spec #45 reviewer surfaced diagnostic objects such as
`review.failure` in Pi's interactive terminal even when the agent could handle
the blocked operation and continue. At baseline
`d9dcf5e5f066ce3b20772f410fbfd8e84efbb384`, the logger explicitly printed selected
events through `console.warn`. The circuit-breaker callback also announced a
stopped turn before calling `abort()`. Forwarded child results could affect the
parent's repeated-denial counters, confusing a child refusal with a reason to
stop the parent's run.

The user's acceptance rule is: feedback an agent can handle belongs in its
tool result; diagnostics belong in the audit; user notices must describe an
actual need for user action. In particular, a stopped notice requires confirmed
completion of the owning main-agent run, not merely a stop request.

## Decision

1. Keep diagnostic JSONL recording and its existing fail-closed audit checks.
   Do not send any diagnostic event to the console by default. The existing
   `PI_SAFE_ALLOW_VERBOSE=1` debugging opt-in remains available and uses the
   same secret-redacted details as the audit destination.
2. Preserve tool-result refusal and recovery feedback, deterministic rules,
   reviewer floors, terminal fallback and native human approval. Silence is a
   presentation change, not an allow or a suppression of requester feedback.
3. Exclude every forwarded child outcome from the parent's circuit-breaker
   counters: child hard denials cannot advance them, and child allows or human
   fallbacks cannot reset or advance them. Preserve denial history and the
   local main agent's existing single-call thresholds and batch exclusions.
4. A local main-agent breaker may request cancellation of its owning run.
   Queue the short Pi UI warning and show it at most once only after that run
   has ended and the host confirms it is idle. If the owning run cannot be
   confirmed stopped, do not claim it has stopped. Do not show a parent stop
   notice for a forwarded child result, and do not carry an old pending notice
   into a different session or run.
5. Surface final registration failures and actionable configuration issues as
   brief deduplicated Pi UI notifications. Expected service-registration races
   and intermediate retry misses remain audit-only. Do not expose raw errors,
   credentials or diagnostic objects in these notices.

No Pi configuration edits, new settings, migration, host patch or third-party
plugin fork are required. Updating and reloading the extension activates the
quiet default; existing reviewer model selections and permissions retain their
meaning.

## Ownership and verification

This is a follow-up to Spec #45's omission/diagnostic work in Issue #57 and
daily-use failure feedback in Issue #58, with the additional presentation and
stop-ownership acceptance above supplied by the user discussion. The earlier
evidence-retention decision in ADR 0011 remains in effect.

The verification record is
[quiet-review-feedback.md](../../../../docs/verification/quiet-review-feedback.md).
Controlled tests must distinguish an `abort()` request from an ended, idle run;
they must also exercise forwarded allows, denials and human fallback against
the parent counter, rather than checking child denials alone. Transport fixtures
prove routing and presentation behavior, not reviewer model quality.
