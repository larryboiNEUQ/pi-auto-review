---
status: accepted (admission semantics superseded by 0010)
date: 2026-09-27
---

# 0009 — Bounded, provenance-labeled Guardian evidence

The latest-user-only reviewer window from the exact-action work lost earlier grants and restrictions; default-off tool results hid factual causal links. For Spec #45 Issue #47, retain bounded, redacted user history from Pi's **active branch only** and causal call/result facts, with explicit provenance, omission markers and request admission. Tool text can inform what happened but never authorize an action. Tool results are included by default with an explicit `includeToolResults: false` opt-out.

The trade-off is larger requests and greater exposure to untrusted factual text. Separate budgets, structural secret redaction, opt-out and token-estimated admission mitigate that cost. Evidence selection uses the Codex-inspired character profile at four characters per token (for example 80,000 characters ≈ 20,000 tokens of user history). Request admission is a different estimate: two ASCII characters per token, and four tokens per non-ASCII code point. Those ratios are not interchangeable and neither is provider-reported usage. An evaluation provider's unknown context limit is not inferred from the chat model; its local cap is not a provider guarantee. Optional call/result pairs are removed together under pressure.

**Amended by ADR 0010 (bounded-provenance-v2):** unsupported user content, compacted history, context edits and truncated instructions are now signaled as marked omissions in the dossier instead of blocking admission. Admission fails closed only for an unbounded request — unknown reviewer context limit, or mandatory evidence that cannot fit after optional eviction.

This supersedes **only** the old latest-user-window/default-off evidence choice: exact-action risk, deterministic permission policy, Authorizer ordering and code-enforced Guardian floors remain unchanged (ADR 0007).
