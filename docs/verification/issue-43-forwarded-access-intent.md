# Issue #43: forwarded One-time Grants and version attribution

## Scope

[Issue #43](https://github.com/larryboiNEUQ/pi-auto-review/issues/43) fixes preservation of authoritative access facts across a forwarded Approval Request. It does not relax the delegation envelope, trust display fields, change the Reviewer model, enable nested forwarding, or change operator permissions. ADRs 0007 and 0008 require the child to own the facts and the serving node to own the judgment.

## Findings before implementation

The real `buildForwardedAskDetails` mapper omits `accessIntent`. The real delegation envelope deliberately requires `details.accessIntent.surface`; a display-only `surface` is not authority. Consequently an otherwise eligible reviewer `allow` becomes `defer`, reaching Terminal Human Review. This reproduces with a reviewer stub that always returns `allow`, without inference or executing any requested action.

| Revision | Release identity | Source reproduction | Shipped `index.js` reproduction |
| --- | --- | --- | --- |
| `96fb23e` | v2.1.0 | Missing intent; allow becomes defer | Same missing-field cap |
| `ca875cc` | v2.2.0 | Missing intent; allow becomes defer | Same missing-field cap |
| `e3445d1` | Development build, still reports 2.2.0 | Missing intent; allow becomes defer | Same missing-field cap |

The installed development build was 16 commits beyond the v2.2.0 tag on `feat/issue-37-reviewer-lineage`. The audit identified its actual Git source and commit rather than inferring runtime identity from its unchanged package version or an unrelated development checkout.

The offline audit extracted the actual mapper and envelope functions from each source revision, and the corresponding mapper/cap functions from each shipped bundle. A forwarded bash fixture carried authoritative facts and a fixed allow verdict. All three revisions lost the facts; preserving the same facts in a control case removed the unintended cap. Both `cap-allow` and `honor-reviewer` still cap requests with missing facts, so changing that configuration is not a fix.

### Introduction versus exposure

- **Introduction: `f0b76b1` (2026-08-11, #18).** Removed the display-surface fallback from the envelope, correctly making authoritative intent mandatory, but did not update forwarded ask reconstruction. The same offline fixture yields `allow` at `f0b76b1^` and `defer` at `f0b76b1`. Restore the facts, not the display fallback.
- **Exposure: `737b9b6` and `6dddfe4` (2026-09-26).** Tintin lineage integration and support for in-memory child sessions make more child asks eligible for parent forwarding. This explains a plausible trigger for an older defect, not a new envelope regression. The available review log contains no forwarded-request-created events before September 26, then 102 in the audited session; this is observational evidence, not a controlled comparison of identical workloads.
- **Separate change in v2.2.0: `546aeba`.** Ordinary non-critical, non-absolute model denials now defer to terminal authority instead of immediately blocking. This can increase human confirmations when the model actually denies; it does not explain allows being downgraded because facts are missing.
- **Separate failure reporting: `7097599`.** Distinguishes reviewer infrastructure failure from a policy/model denial. Both old and new behavior stop the action on infrastructure failure; classification is not the missing-intent bug.
- **Separate evidence-window behavior: `323a825` (2026-08-18).** Starts reviewer evidence at the latest user message. This is identical across the three compared revisions and can make a bare continuation request lose earlier authorization context. It is not changed by this issue.

The experimental nested-forwarding option is off by default. Neither its presence nor its enablement is required for the one-hop regression; the historical process environment was not proven by reading today's configuration.

### Session observations (sanitized)

There were 84 associated model outcomes: 77 allow, 2 deny, 3 transport failure, and 2 model failure. All 15 forwarded requests requiring human grants had reviewer allow outcomes. One timed out ten minutes after forwarding despite an earlier reviewer allow; the eventual response could not be written after cleanup. This issue repairs the unnecessary escalation, not timeout state/error wording. Review-log labels alone do not prove a human clicked: existing code can label an automated approval as `user`.

## Reproducing the version comparison

Use a checkout with the referenced Git objects (fetch full history, tags, and the development branch if needed) and workspace development dependencies installed with `npm ci --ignore-scripts`. Run the fixed-revision offline probe:

```sh
node scripts/verify-forwarded-intent-history.mjs
```

It extracts only the historical pure mapper/envelope functions and their shipped-bundle counterparts, stubs the reviewer to allow, and verifies a preserved-facts control. Expected output: all three source revisions yield `defer`, all three bundles cap missing facts in both modes, `f0b76b1^` yields `allow`, and `f0b76b1` yields `defer`. It does not invoke a model, execute the requested command, or modify files/configuration. Run it only against this repository's trusted historical objects. This intentionally version-pinned diagnostic is separate from the forward-looking regression suite.

The following read-only comparisons independently verify attribution:

```sh
git diff v2.1.0 v2.2.0 -- \
  packages/pi-permission-system/src/authority/forwarded-request-server.ts \
  packages/pi-permission-system/src/authority/delegation-envelope.ts \
  packages/pi-permission-safe-allow/src/dossier.ts

git diff v2.2.0 e3445d1 -- \
  packages/pi-permission-system/src/authority/forwarded-request-server.ts \
  packages/pi-permission-system/src/authority/delegation-envelope.ts \
  packages/pi-permission-safe-allow/src/dossier.ts

git show f0b76b1 -- packages/pi-permission-system/src/authority/delegation-envelope.ts
git rev-list --count v2.2.0..e3445d1
```

Both diffs are empty; the count is 16. Across all three revisions the mapper, envelope, and dossier blob IDs are respectively `daf73e091d30dc0021253db13a36d54caf406537`, `d9199ee9d2c1d9dfd495935dade4faac8dedb136`, and `c6e1b27335b3dff7de50b41c1d10d2c1e8266ff1`.

## Fix verification

The serving mapper now carries the validated child intent unchanged. The delegation envelope itself is unchanged.

### Public-boundary red/green

```sh
npm run test -w @gotgenes/pi-permission-system -- --run \
  test/authority/forwarded-request-server.test.ts -t 'nonpersistent reviewer grant'
```

With only the mapper fix temporarily removed, both bash and external-directory cases fail at the response boundary: expected `{ approved: true, state: "approved" }`, received `{ approved: false, state: "denied" }`. Restoring the fix makes the whole forwarded-request suite pass: **25 tests**. This exercises the real inbox reader/validator, server, composed authorizer chain, delegation envelope, and response writer. The reviewer is a deterministic stub and the human terminal is a denying test double; no real action or model call occurs.

Security controls in the same suite verify default path caps versus explicit `honor-reviewer`, conflicting display fields, missing and malformed facts in both modes, policy-deny precedence, reviewer deny/defer behavior, child match/boundary/provenance preservation across different cwds, and repeated One-time Grants without recording session rules.

### Local gates

- `npm run check`: both packages pass.
- `npm test`: permission-system **2,630 tests** and safe-allow **259 tests** pass, plus the bundle/host-resolution/differential checks. The differential unit runner reports one existing opt-in integration skip; no failure is treated as a pass.
- `npm run build -- --check`: committed bundle matches all 139 source inputs.
- `node scripts/verify-forwarded-intent-history.mjs`: all historical source/bundle assertions pass.
- `git diff --check`: passes.

Independent Standards/Spec review outcomes and exact-commit remote CI are tracked on PR #44 and Issue #43 after these local gates. An open PR is not evidence of deployment; the active installation and user permission configuration are unchanged.
