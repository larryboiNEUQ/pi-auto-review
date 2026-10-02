---
status: accepted
date: 2026-10-02
supersedes: user-history selection and hard-window recovery in 0009 and 0010
---

# 0011 — Preserve user history before whole-request budget recovery

Final review of PR #52 found that the 80,000-character authorization pool and
100-entry selection cap could retain an earlier host-user grant while omitting a
later revocation. The resulting request could pass admission with an incomplete
authorization timeline. Increasing those caps or pinning only the last user turn
does not protect a restriction in an earlier turn followed by a short “continue”.
This follow-up belongs to Spec #45 and its evidence/omission work in Issues
#47/#57; it is not a separate approval capability.

## Decision

Follow the Codex Guardian distinction between soft evidence selection and the
hard input budget of the complete reviewer request:

1. Collect all text parts of each genuine host-user message in their original
   order. Retain every available host-user message from the active branch during
   soft selection, without the 80k-character pool or 100-entry cap. Preserve
   chronological order. Existing bounded selection still applies to optional
   assistant/tool facts. No keyword filtering or semantic summary is introduced.
2. Measure the complete chat or Jev request using the existing Pi admission
   estimator and backend limit, including policy/instructions, exact action,
   current parent restrictions and other non-trimmable requirements.
3. If the request does not fit, evict optional non-user evidence first. An
   observed tool call and its result are removed together, with explicit omission
   diagnostics; recovery must not leave a selected causal pair split.
4. If it still does not fit, shorten ordinary host-user historical text from
   oldest to newest. Keep its beginning and end, respect UTF-8 boundaries, and
   insert an explicit omission marker. Re-estimate the actual request after
   recovery. Omission counts and reasons remain visible in the dossier and audit.
5. Do not shorten the current action, forwarded parent restrictions, required
   system instructions or policy. If those requirements and recovery markers
   still cannot fit, block before inference and action execution. An unknown
   chat reviewer window remains a blocking admission failure.

The same admission/recovery rules apply to chat and Jev. Compaction summaries
remain derived, untrusted evidence and cannot grant or attest authorization.
Host changes during a review still invalidate that review; this decision changes
evidence assembly, not the release checks or deterministic permission floors.

## Alignment scope and trade-off

The reference is Codex revision
[`98072cf5f68a2959961d5aa0ef0c9a78d6db80d1`](https://github.com/openai/codex/tree/98072cf5f68a2959961d5aa0ef0c9a78d6db80d1).
A second source audit at
[`ca466061d64f0b44f416135c7fd06aa7af850bbc`](https://github.com/openai/codex/tree/ca466061d64f0b44f416135c7fd06aa7af850bbc)
confirmed the same relevant behavior:
[complete soft retention](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/guardian-context/src/profile.rs#L177-L223),
[Historical/Required source distinction](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/guardian-context/src/profile.rs#L257-L275),
[oldest-first hard recovery](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/guardian-context/src/enforcement.rs#L169-L232),
and [head/tail UTF-8 truncation](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/guardian-context/src/truncation.rs#L12-L37).

Pi has no authenticated retained-source delivery proof corresponding to Codex's
`Required` user sources. Ordinary Pi host-user history therefore follows
`Historical` recovery; a skill-shaped message or extension-defined custom entry
must not be promoted to an invented required source. Current parent restrictions
and system/action requirements keep their existing Pi provenance and protection.
Pi also has no reviewer-host compaction interface equivalent to Codex's recovery
path. This is an alignment of selection and final budget-recovery behavior, not
a full port of Codex context management or an end-to-end parity claim.

The evidence contract remains `bounded-provenance-v2`; the repair changes soft
retention and hard recovery without adding an authenticated provenance class.
User-looking text from tools or derived summaries is not eligible host-user
history. The `review_request_history_truncation` diagnostic and in-band marker
identify user text shortened by complete-request recovery.

Pi continues to estimate admission as one token per two ASCII characters and
four tokens per non-ASCII code point. Jev retains its 24k estimated-token local
cap. These differ from Codex's budget accounting and are not measured provider
usage. The distinction affects where hard recovery begins.

This fixes the premature loss of a recent revocation at the soft cap. It does
not guarantee that every user restriction survives a real hard-window overflow:
even the latest ordinary user message can require shortening, and a restriction
in its middle can be removed. The marker makes that evidence gap explicit; it
does not recreate the missing instruction or prove that a reviewer will deny.
The user accepted this Codex trade-off after deterministic comparison tests.

Formal regression and integration results are recorded in
[`issue-45-user-authorization-retention.md`](../../../../docs/verification/issue-45-user-authorization-retention.md).
