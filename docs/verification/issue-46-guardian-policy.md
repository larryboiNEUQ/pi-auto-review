# Issue #46 — default Guardian outcomes (v2)

Baseline: published v2.3.0 (`3ccc7d7`). Upstream behavioral reference: Codex synchronous Guardian policy at `98072cf5f68a2959961d5aa0ef0c9a78d6db80d1`. This issue changes the model-visible default, not deterministic permission routing, the tool-result default, the selected reviewer, or OS containment.

## Contract and limits

`guardian-outcomes-v2` applies the low/medium default allow regardless of authorization, except explicit policy prohibition or affirmative malicious prompt injection (an untrusted instruction unrelated to the user's task). High risk still requires medium-or-higher semantic authorization and narrow scope; critical and absolute-deny decisions block. Exact action effects determine intrinsic risk and scope, not task size, browser login state, escalation, path location, or the unknown body of a read. Unknown executable payloads and unresolved targets remain distinct from unknown read output. The same rule appears in chat instructions/default policy and `guardian-jev-v2` evaluation questions. Neither a custom `policyPath` nor operator `instructions` is rewritten on upgrade; model choice is unchanged.

Pi remains stricter than the referenced Codex implementation in code: deterministic excludes, critical/absolute and high-risk floors, sensitive-path allow cap, structured result validation, and blocking on reviewer failure still apply. A *completed* low/medium reviewer denial is **not** converted into an allow; it follows ordinary same-ask native approval when eligible. Scripted reviewer tests prove the wiring and floors, **not** that a live model follows its prompt. Comparative live inference belongs to #51.

## Verification

- `npm run check`: both workspaces pass.
- `npm exec --workspace packages/pi-permission-safe-allow vitest run test/config-loader.test.ts test/escalation.integration.test.ts test/jev-evaluation.test.ts`: 145 tests pass (both backends, thresholds/authorizations, conflicting custom policy, captured explicit prohibition/injection/absent-evidence fixtures, denial/floor routing, and the disposable dispatcher executor sentinel); versioned question snapshot updated.
- `npm run build && npm run build -- --check`: bundled `index.js` rebuilt from 143 input files and matches sources.
- `npm test`: permission-system 2,630 and safe-allow 298 tests pass; differential unit suite 12 pass, one Windows-only skip; bundle checks pass.

GitHub macOS/Windows CI and independent code-review evidence must be recorded on PR #52 and Issue #46 against the final pushed commit before marking this issue complete. No paid inference or real remote action was performed in these tests.
