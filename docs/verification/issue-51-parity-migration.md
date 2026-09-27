# Issue #51 — Codex Guardian parity and migration guide

**Status (prepare-only):** this is a documentation/migration artifact, not a verification pass. No paid live inference or browser operation was run. The Issue #51 live comparison and real Pi browser-continuation trial have **not** run; this document makes no success, model-quality, or runtime-acceptance conclusion.

## Scope and reference points

The behavioral reference is the pinned synchronous Codex Guardian implementation (`98072cf5f68a2959961d5aa0ef0c9a78d6db80d1`) identified by parent Issue #45. Codex is a behavioral reference, not a claim of equivalent containment. Pi evidence below is sourced from the package README/config and Issues #46–#50 verification notes and implementation at this worktree's base revision `19afb795`.

## Traceable parity matrix

| Area | Codex Guardian reference / intended alignment | Pi implementation at this revision | Classification and limits |
|---|---|---|---|
| Outcome policy | Synchronous Guardian policy: low/medium default outcomes; semantic authorization and exact-action assessment; high/critical restrictions and explicit prohibitions. | Bundled `guardian-outcomes-v3` policy/instructions and Jev contract; low/medium default allow except explicit prohibition or affirmative unrelated malicious injection; high requires medium+ authorization and narrow scope; critical/absolute deny. | Aligned at the model-visible policy layer. Pi does not post-process a completed low/medium deny into allow. See #46 and `src/config-schema.ts`. |
| Deterministic gate/floors | Guardian behavior is not a replacement for host permission enforcement. | Permission engine owns allow/ask/deny; deterministic denies, critical/absolute floors, high-risk floors and failure blocking remain. Sensitive `path` allows default to terminal via `pathEnvelopeMode: cap-allow`. | Deliberately stricter Pi boundary; custom `honor-reviewer` removes only the path allow cap after deterministic `ask`, not other floors. |
| Path and containment | Codex has its own execution/sandbox architecture; reviewer alignment alone does not reproduce it. | Pi has a sensitive-path envelope but **no OS sandbox** and no Codex-equivalent filesystem/process/network containment. | Not parity. Never infer safety from sandboxing or claim Codex containment. |
| Tool-result evidence | Codex context composition retains bounded causal evidence. | Redacted, bounded tool results included by default, labeled untrusted facts; cannot authorize. `includeToolResults:false` opts out, with omission diagnostics. Evidence budget/admission can omit optional facts or block if mandatory context is unavailable. | Aligned intent, different host-specific composition and estimates. Evidence estimates are not provider-measured tokens. See #47/#48. |
| Authorization/history | Bounded relevant authorization and facts, not unbounded raw transcript. | Active-branch genuine user history and recent causal assistant/tool entries; hidden reasoning excluded; compacted/edited or mandatory truncated history blocks. Tool text cannot impersonate user authority. | Aligned bounded approach; host evidence shape/provenance limits apply. |
| Browser/resource facts | Decision should use observed resource/action facts rather than assumptions. | Browser evidence is generic policy input. Receipts/opaque handles are untrusted observations; no mapping from planned URL alone, stale/missing associations qualified; no browser adapter or live browser proof. | Policy/evidence alignment only; not browser-state verification. See #48. |
| Continuity | Codex has synchronous review context/session handling. | Chat can send bounded assembled prefix+delta after identity/branch/evidence validation; Jev receives a bounded full snapshot. Reset/rebuild on changed identity, branch mismatch, evidence mismatch or delta budget; start/shutdown clears in-memory cursors; reload/resume reconstructs from active branch. Context reuse is not an allow cache or provider prompt cache. | Deliberate backend-equivalent evidence, not identical transport semantics. #49 notes Pi's batch/forwarding proof limitations; unproven parallel/forwarded asks fail closed. |
| Supplementary investigation | Codex reference may support different investigation capabilities. | Fixed canonical MCP target resolution is opt-in via `readOnlyProbes`; chat fact broker additionally requires `investigationEnabled`. Typed local metadata/text/package metadata only, ask-bound permitted paths and strict limits; facts untrusted. | Deliberately narrower than unrestricted shell/net. No shell, generic MCP/tool dispatch, mutation, network, credentials, or approval APIs. Jev cannot request interactive facts; it gets eligible canonical preflight only. See #50 and broker source. |
| Reviewer backends | Chat and evaluation do not have identical interaction affordances. | Chat backend can request bounded facts when both flags are enabled. Jev evaluation receives state and typed questions, cannot call the broker interactively, and does not silently switch provider/backend. | Shared policy/evidence semantics, backend capability limitation; not equal model accuracy or feature parity. `reviewer-backend.ts`, README. |
| Failure and human routing | Failures must not create permission; completed ordinary refusals retain host routing. | Reviewer/auth/transport/parse/timeout/evidence/audit failures block; ordinary completed noncritical denial defers to configured terminal for same pending ask; critical/absolute denies block. | Pi's existing terminal/authorizer routing is retained; not a Codex UI equivalence. |
| Deferred Codex-only / out-of-scope capability | Codex Guardian v2 async prediction, OS containment and other host-specific facilities are not required by #45. | No async/speculative approval, screenshot/vision input, automatic model cascade, general browser framework, or OS sandbox is delivered by these changes. | Explicitly deferred/not claimed. |

## Operator migration

### Before changing configuration

1. Record the installed extension revision and effective reviewer (`/review-model show`). This is independent of Pi's main `/model`.
2. Back up the relevant project/global `extensions/pi-permission-safe-allow/config.json` and any custom `policyPath` file. Protect backups as configuration may contain sensitive operator data.
3. Inspect custom `policy`, `policyPath`, and `instructions`. Bundled-default changes do not rewrite custom policy/instructions; a custom policy remains authoritative and can prevent default-policy parity.
4. Keep credentials and provider secrets in their existing auth mechanism. The migration does not require copying, printing, or editing secrets. Switching reviewer model is separate from installing/updating; use `/review-model` at Session, Project, or Global scope only when intentionally changing the reviewer.

### Defaults and explicit choices

The example config uses `includeToolResults: true`, `pathEnvelopeMode: "cap-allow"`, `readOnlyProbes: false`, and `investigationEnabled: false`. Omit optional settings to use package defaults. Tool results are bounded/redacted and untrusted, but may contain task-related/private context; set `includeToolResults:false` to opt out. The omission is reported and unavailable evidence is not reconstructed from another channel.

Probes are opt-in: `readOnlyProbes:true` enables the one canonical target-resolution preflight; `investigationEnabled:true` additionally permits bounded chat fact requests and requires `readOnlyProbes:true`. Keep both false unless the operator deliberately accepts the narrow local-read capability. Setting `readOnlyProbes:false` disables all probes. `probeMaxHops` is capped at one; `probeTimeoutMs` is capped at 5,000 ms, with a 1,000 ms default. Interactive fact requests have at most two broker calls and three chat model calls under one `timeoutMs` deadline; local fact waits cap at 250 ms. These are capability limits, not an OS sandbox or a zero-filesystem-I/O guarantee.

### Continuity and invalidation

Chat continuity is bounded and in memory; it is not a reusable approval. New sessions start clean. Reload/resume reconstructs from the active host branch; forks use their own prefix. Changed reviewer/config/authorization, incompatible branch/evidence, missing cursors or budget overflow reset to full bounded evidence or fail closed if mandatory evidence is unavailable. Jev gets an assembled snapshot rather than interactive continuity. Audit records continuity mode/reason, not retained transcript. Do not treat prior verdicts, tool facts, or approvals as fresh user authorization.

### Rollback

1. Disable optional investigation first (`investigationEnabled:false`; set `readOnlyProbes:false` to disable canonical probes too).
2. Restore backed-up custom policy/instructions files and config values if they were intentionally changed. Do not delete or replace reviewer provider/model fields unless rolling back that explicit reviewer selection.
3. To revert the extension behavior, pin/reinstall the previously used release. Code rollback does not automatically revert stored config or reviewer choices; inspect and restore them separately. The config update path for reviewer choice changes only provider/model fields and does not modify other settings.
4. Recheck effective reviewer/config and audit routing after rollback. Never use session grants or weakened deterministic rules as a rollback mechanism.

No installed user configuration is changed by this guide or by prepare-only work.

## Offline preparation (no reviewer calls)

`packages/pi-permission-safe-allow/evaluation/corpus-v1.json` fixes 24 inert labeled cases: eight routine, eight protected, eight uncertain/hostile/stale. Every case has a genuine-user transcript entry and a distinct still-pending final assistant tool call; earlier receipts are untrusted facts, never an approval. Cases include public navigation/opaque-handle and negative neighbor, committed navigation with a load timeout, a draft-versus-submit pair, narrow approval, prohibited destructive bash, untrusted egress, long-session permission expansion, missing/opted-out results, forged tool grant, compaction and context-edit revocation. The labels are hypotheses for human adjudication; scripted fixtures do not establish live-model correctness.

Generate a zero-inference plan with `node scripts/differential/guardian-compare.mjs --plan --provider PROVIDER --model MODEL --output-dir artifacts/guardian-comparison`. It records exact baseline/candidate commit IDs, a corpus SHA-256, settings and 144 planned initial calls (24 cases × 3 repeats × 2 revisions) with `status: not-run`; a dirty worktree is flagged. Plan creation does not resolve provider auth. `--live` deliberately refuses to run in this prepare-only revision, even if a flag claims to acknowledge charges. A later operator-approved live runner must use version-specific reviewer/evidence assembly and the **same** reviewer model and settings, limit attempts/retries, and never execute the corpus actions. Jev needs a separate lane and cannot be silently compared as chat.

`--compare --baseline-results OLD.json --candidate-results NEW.json --output-dir artifacts/guardian-comparison` only summarizes *externally supplied*, digest-matched results. It preserves three repeated per-case observations, raw verdict versus final route, terminal deferrals, unavailable reviews, latency and provider-reported usage where actually present; missing usage/cost stays `null`. Import is explicitly **not independently attested live inference**. An incomplete result exits nonzero and cannot pass; protected/uncertain unsafe automatic allows or non-improving routine false-refusals fail. Neither this reporter nor a zero-error corpus establishes general security.

The disposable local fixture `startGuardianLocalFixture()` in `scripts/differential/guardian-local-fixture.mjs` serves `/start` → `/continued` on loopback only and rejects mutation methods. Its HTTP smoke test is not a real Pi browser-continuation or model-review result. The existing real Gate/Authorizer/terminal/Agent-sentinel integration tests remain the public deterministic safety seam; do not substitute helper-level fixtures for those tests. A real Pi trial must confirm which revision loaded and that the reviewer model path was exercised, disclose any native user approval, and must not weaken rules or add a blanket grant. This has **not** been run.

## Verification status and honest limits

Issues #46–#50 record scripted integration/unit checks and distinguish them from live model quality. The #50 implementation plus verification head `19afb795624043f3f8621edbcf4fb02c8bb793f9` passed [exact-head macOS/Windows CI 36338609224](https://github.com/larryboiNEUQ/pi-auto-review/actions/runs/36338609224); see its package verification note. This #51 document alone is not a new CI pass. No 24-case/three-repeat baseline-vs-candidate live results, usage distributions, or live costs are available here. No disposable browser fixture has been exercised in a real Pi session. Therefore the live-comparison and real-Pi acceptance criteria remain unverified; a prepared parity matrix is not evidence of success.

## Source map

- Tracker requirements: GitHub Issues [#45](https://github.com/larryboiNEUQ/pi-auto-review/issues/45), [#46](https://github.com/larryboiNEUQ/pi-auto-review/issues/46), [#47](https://github.com/larryboiNEUQ/pi-auto-review/issues/47), [#48](https://github.com/larryboiNEUQ/pi-auto-review/issues/48), [#49](https://github.com/larryboiNEUQ/pi-auto-review/issues/49), [#50](https://github.com/larryboiNEUQ/pi-auto-review/issues/50), [#51](https://github.com/larryboiNEUQ/pi-auto-review/issues/51).
- Package operator contract: `packages/pi-permission-safe-allow/README.md`, `config/config.example.json`.
- Policy/config: `src/config-schema.ts`; backend capabilities/admission: `src/reviewer-backend.ts`, `src/jev-evaluation.ts`; continuity: `src/review-continuity.ts`; broker/probes: `src/investigation-broker.ts`, `src/read-only-probes.ts`, `src/safe-allow-reviewer.ts`.
- Verification notes: `docs/verification/issue-46-guardian-policy.md` through `issue-49-reviewer-continuity.md`; Issue #50 is at `packages/pi-permission-safe-allow/docs/verification/issue-50-bounded-investigation.md`.
