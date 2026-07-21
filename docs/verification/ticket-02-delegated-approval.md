# Ticket 02 delegated-approval verification

## Baseline

- Refreshed: 2026-07-22 (Asia/Shanghai).
- Official product baseline: current OpenAI Codex manual, sections
  **Automatic approval reviews** and **Auto-review**.
- Open-source Guardian baseline: `openai/codex` `main` at
  `51200321eb7b862a29ffceaba8b19db1934a9b38`; `policy.md` was fetched from
  that exact commit and compared with the implementation decisions below.
- Earlier research pin retained for historical comparison: Codex `0.144.4`,
  tag `rust-v0.144.4`, observed 2026-07-21.

The refreshed sources still describe Auto-review as a reviewer swap at an
existing approval boundary. Routine permitted actions do not call the reviewer;
critical risk and absolute policy denies block; high risk requires sufficient
semantic authorization; failures fail closed; timeout is distinct from an
explicit denial; denial circuit breakers are 3 consecutive or 10 of the last
50 reviews; and `/approve` authorizes one exact reviewed retry.

## Security boundary

No OS sandbox was added. This fork aligns the delegated approval lifecycle but
does **not** provide Codex-equivalent filesystem, process, or network
containment. Pi's deterministic policy engine remains the only hard permission
boundary. The semantic reviewer can judge only the exact action represented in
its dossier.

## Requirement-to-test traceability

| Requirement | Implementation evidence | Automated evidence |
| --- | --- | --- |
| Policy `allow` bypasses review; policy `deny` cannot be loosened | `GateRunner` constructs delegated facts only inside the `ask` callback; authorizer links never see deterministic allow/deny | permission-system `runner.test.ts`; full permission-system suite |
| Every eligible ask uses one reviewer seam | bundled default `authorizerChain: ["safe-allow"]`; `createSafeAllowReviewer` has no surface allowlist | safe-allow `reviewer.test.ts` registered-chain cases |
| Typed exact dossier and permission delta | `DelegatedApprovalFacts`, `ApprovalDossier`, action-kind union, exact SHA-256 action identity | `delegated-approval-facts.test.ts`, `dossier.test.ts` |
| Cwd, policy, transcript, justification and prior denial | gate facts plus compact session evidence and one-shot override marker | `runner.test.ts`, `dossier.test.ts`, `reviewer.test.ts` |
| Secret-safe prompt, forwarding and audit | recursive field/value redaction; forwarded facts validator rejects unredacted credentials; audit writes a redacted projection | `delegated-approval-facts.test.ts`, `forwarding-io.test.ts`, `dossier.test.ts` |
| Guardian risk/authorization semantics | structured `riskLevel`, `userAuthorization`, `scope`, `absoluteDeny`; local critical/high thresholds | `review-contract.test.ts`, critical-denial registered-chain test |
| Static script review and unknown payload fail-closed | complete command text remains in the shell action; variable `eval` / shell `-c` payloads mark the dossier incomplete | `delegated-approval-facts.test.ts` |
| MCP uses annotations and exact parameters | typed MCP server/tool/annotations/account/arguments facts; no tool-name blacklist | MCP dossier contract test |
| Trusted Skill selection does not prompt | Skill selection returns allow without a model call; emitted actions keep their native surface | registered-chain Skill test |
| Auth/model/transport/parse/timeout/cancel/session/missing-evidence failures block | bounded `reviewDossier`; no successful `defer`; failure reasons are non-approved decisions | malformed retry, auth, timeout, model/missing dossier tests plus full suite |
| Timeout distinct from explicit denial | timeout has its own failure code and wording stating it is not evidence of unsafe action | registered-chain timeout test |
| Denial rationale and non-circumvention | explicit denial reason appends the no-workaround instruction | registered-chain critical-denial test |
| 3 consecutive / 10-in-50 breakers | per-turn `DenialLifecycle`, current context abort on trip | lifecycle and registered-chain breaker tests |
| Exact one-shot override | `/approve` selects one of 10 recent denials; identity-keyed marker is consumed once and action is reviewed again | lifecycle one-shot and registered-chain re-review tests |
| Structured audit | routing, decision, risk, authorization, rationale, attempts, timing, override, failure and breaker events | reviewer integration tests plus JSONL inspection in local smoke |
| macOS/Windows contract parity | platform-neutral dossier/review code and POSIX/Windows path fixtures; CI matrix runs all tests plus real install/load/update | two-platform facts test; `.github/workflows/git-bundle-smoke.yml` |
| Git install and real Pi loading | root bundle installs exact workspace dependency and loads both extensions in order | `scripts/verify-git-bundle.mjs`; macOS/Windows CI matrix |

## Intentional divergences and deferred receipts

- **No sandbox equivalence:** deliberate product boundary, stated above and in
  the dossier presented to every reviewer.
- **Pi decision type:** Pi's authorizer seam represents timeout/operational
  failure as a non-approved decision with a distinct reason and audit code;
  it does not have Codex's separate TUI review-state enum.
- **Read-only reviewer tools:** the Pi reviewer receives the exact dossier and
  compact evidence but is not given extra read-only tools. Missing action facts
  fail closed instead of starting a second exploratory agent.
- **`path` envelope:** the plan-B deterministic delegation envelope still caps
  reviewer `allow` on the sensitive `path` surface. The reviewer may deny it;
  an allow falls through to the human terminal. This is intentionally stricter.
- **Disabled mode:** `disabled: true` explicitly returns asks to the configured
  terminal authorizer. This operator kill switch is not a successful automatic
  review verdict.
- **Local execution:** macOS local tests and the changed-HEAD real Pi Git
  install/load/update smoke are executed before completion. Windows and hosted
  macOS receipts come from the workflow matrix after the commit is pushed.
- **Real model CLI scenarios:** deterministic registered-chain integration
  covers Bash allow, critical deny, timeout, Skill, exact override, and failure
  behavior without external model credentials. A live-provider Pi CLI review
  is not claimed as executed; the real Pi smoke covers installation, discovery,
  load order, registration prerequisites, and update.
