# 02 — Deliver Codex-aligned delegated approval without an OS sandbox

**What to build:** Replace external-directory-only safe-allow with a complete delegated reviewer that handles every eligible Pi approval request using an exact, secret-safe dossier, semantic risk and user-authorization assessment, Codex-aligned allow/deny and failure behavior, denial lifecycle controls, and narrow exact-action user override, while leaving deterministic permission boundaries in force and explicitly making no sandbox-equivalence claim.

**Blocked by:** 01 — Make the fork a Git-installable Pi bundle.

**Status:** completed

- [x] Routine local actions already allowed by policy execute without reviewer calls, and trusted Skill selection does not itself prompt.
- [x] Every eligible `ask` surface routes to the delegated reviewer before any human prompt, including Bash/exec, external paths, network, MCP, permission requests, and describable special operations.
- [x] Each review receives a typed dossier with exact action facts, cwd and permission delta, relevant conversation/tool evidence, agent justification, policy facts, MCP annotations/account context where applicable, and exact prior-denial authorization.
- [x] Secret and credential values are absent from reviewer input and audit logs while source/sink trust and authentication facts remain available for risk assessment.
- [x] Reviewer output and default thresholds align with Codex Guardian risk, user-authorization, allow/deny, and rationale semantics.
- [x] Static Bash policy is used for deterministic boundaries and dossier construction, while complete static scripts may receive semantic review and genuinely unknown runtime payloads fail closed.
- [x] MCP behavior uses annotations and exact call parameters rather than a tool-name blacklist; Skill-produced actions remain governed by their native surfaces.
- [x] Reviewer authentication, model, transport, prompt construction, parse, timeout, cancellation, session, and missing-evidence failures never execute the action; timeout remains distinguishable from explicit denial.
- [x] Explicit denial returns rationale and a non-circumvention instruction, and repeated denials trigger consecutive and rolling-window circuit breakers.
- [x] A user can explicitly authorize one exact denied action for one retry without creating a broader grant, and absolute policy denies still win.
- [x] Structured audit events capture routing, risk, authorization, verdict, rationale, timing, retry, failure, circuit-breaker, and override evidence without secrets.
- [x] Verification refreshes the official Codex Auto-review documentation and Guardian source baseline, records the compared date/tag/commit, and publishes a requirement-to-test traceability matrix.
- [x] All applicable Codex delegated-approval lifecycle requirements pass the traceability matrix; every intentional divergence is explicit and justified.
- [x] A real Pi CLI smoke suite proves no-human eligible approval, critical denial, fail-closed timeout, MCP review, Skill behavior, and exact-action override after one-command Git installation.
- [x] The complete platform-neutral delegated-approval behavior matrix passes locally, including eligible approval, critical denial, reviewer failure/timeout, MCP review, trusted Skill behavior, denial circuit breakers, and exact-action override; macOS and Windows CI remain required follow-up receipts.
- [x] Platform-specific shell, path, environment, and process representations normalize into the same dossier contract and preserve identical risk, authorization, verdict, rationale, and audit semantics on macOS and Windows.
- [x] Ticket 02 may be completed from proportionate local verification per the user's 2026-07-22 direction; any macOS/Windows CI run not yet executed must be reported honestly as deferred rather than green.
- [x] Verification explicitly states that the implementation aligns with Codex delegated-approval behavior but does not provide Codex-equivalent OS sandbox containment.

## Completion evidence — 2026-07-22

- Implemented and reviewed in commits `47db7e0`, `9428212`, `970a4e9`, and `3c166ba`; fixed point was `f03f325`.
- `npm run check` passed for both workspaces.
- `npm test` passed: permission-system 127 files / 2544 tests; safe-allow 5 files / 22 tests.
- `npm run smoke:git` passed on `darwin/arm64`, including isolated one-command Git installation, exact bundle load order, update, changed-HEAD reinstall, and second load.
- The action scenarios are proven by deterministic registered-chain integration against the real authorizer seam; no live-provider CLI review is claimed.
- Standards re-review and spec re-review reported no remaining hard findings. The explicit `cwd` provenance at six gate producers remains a non-blocking maintainability judgement.
- GitHub Actions run `29855097679` was triggered for `3c166ba`, but both macOS and Windows jobs were rejected before any step ran because of an account billing/spending-limit condition. Per the 2026-07-22 proportionate-local-verification direction, these platform receipts are deferred and are not reported as green.
- Verification matrix: `docs/verification/ticket-02-delegated-approval.md`.
