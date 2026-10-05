# Forwarded review freshness and bounded failure diagnostics

This change repairs [issue #60](https://github.com/larryboiNEUQ/pi-auto-review/issues/60) and [issue #61](https://github.com/larryboiNEUQ/pi-auto-review/issues/61). It does not disable authorization checks or identify the historical upstream model failure.

## What failed

Parent assistant messages and tool results changed the branch identity while a child approval waited. The reviewer invalidated its evidence snapshot, and the final authorizer independently invalidated its approval epoch. Both checks were legitimate safety boundaries, but there was no bounded path to review the new evidence.

Chat replies with `stopReason` equal to `error` or `aborted` became a generic `model` failure. Retry and terminal diagnostics lost the observed stop reason. The original provider failure cannot be reconstructed from those historical records.

## Fresh review and final release

`authorization-receipt.ts` captures immutable host-entry digests and ordered branch IDs. Only an identical historical prefix followed by assistant or tool-result messages qualifies for refresh. New user, developer or system authority, edited history, compaction, branch divergence, owner changes and configuration changes fail closed.

A forwarded request can refresh once. It discards the stale result, rebuilds and admits current evidence, rechecks the exact target permissions, and requests a new decision for the same action. The original deadline and total `maxAttempts` apply to all inference, retry and investigation rounds. Queued input prohibits refresh, including on otherwise compatible batches. Local requests retain their original invalidation behavior.

The fresh allow carries a module-private WeakMap receipt. It is not a model field, JSON property or wire capability. Chain conversion transfers its identity to the local decision. The final selection guard checks the action, request, owner, current branch, policy, activation and strict evidence callback before consuming it once. Forwarded continuity commits wait for that consumption. Missing, cloned, forged, expired, replayed and stale receipts do not bypass the original guard. Human approvals have no receipt and retain the strict approval epoch.

New tool results are never globally ignored. Relevant evidence can produce a fresh refusal. Repeated progress after the single refresh blocks instead of spinning or releasing the first approval. Permission and policy changes still block.

## Diagnostic boundary

The backend retains finite source and failure classifications, observed `error` or `aborted` stop reasons, and genuinely supplied numeric HTTP status. Retry diagnostics add the attempt, provider, model, backend and elapsed time. Final failure audits retain the last bounded diagnostic. Successful recovery preserves the earlier attempt in the retry audit.

Arbitrary provider messages, headers, credentials, request context and tool parameters are excluded. HTTP status is not inferred from text. Provider-aborted replies remain distinct from caller cancellation and deadline expiry. Public tool feedback uses locally authored guidance. A failed or throwing retry audit stops further retries and fails closed.

## Failing tests before repair

The #61 regression commit is `5753ff7`. Against the old source it produced:

```text
Test Files  1 failed (1)
     Tests  13 failed (13)
```

The #60 forwarding regression commit is `30322d8`. Against the old authority path it produced four failures. Harmless parent progress blocked the child rather than refreshing, and relevant-result and churn cases never reached a second review:

```text
AssertionError: expected { action: 'block', …(1) } to match object { action: 'allow' }
AssertionError: expected [ { schemaVersion: 1, …(9) } ] to have a length of 2 but got 1
```

The same real parent selection, inbox server and child Gate regressions pass after the repair. Their disposable sentinel is absent while either review waits. A fresh valid allow writes it exactly once. Revocation, hard changes, relevant refusal, repeated churn and invalid receipts leave it absent. No child or parent session grant is recorded.

## Reproduce the checks

Run from the repository root with Node.js 22 or later.

```sh
npm ci --ignore-scripts
npm run check
npm run build -- --check
npm test
npm run test --workspace pi-permission-safe-allow -- test/reviewer-diagnostics.test.ts
npm run test --workspace pi-permission-safe-allow -- test/escalation.integration.test.ts -t 'issue60 fresh'
```

Run the focused fixtures on an unmodified native Pi installation. Replace the host path with your installed package directory.

```sh
PI_AUTO_REVIEW_TEST_HOST_ROOT=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
  npm exec --workspace packages/pi-permission-safe-allow -- \
  vitest run --config ../../scripts/native-pi-vitest.config.mjs
node scripts/verify-per-call-batches.mjs \
  --pi-root /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
  --peer-root ./node_modules/@earendil-works/pi-coding-agent \
  --output /tmp/issues-60-61-runtime-receipt.json
```

## Observed validation

Source `e5696ab` passed both workspace typechecks, bundle/source verification, and the root test suite. Permission-system passed 2761 tests. Safe-allow passed 590 tests with 32 skips. Differential tests passed 33 cases with one platform skip. Bundle helper tests passed four cases.

Native Pi 1.0.0 passed 45 focused cases, including 22 new forwarded freshness scenarios. Other dispatcher cases were outside the native selection. The loaded bundled-plugin harness passed 16 controlled CLI cases, including owned parent-child forwarding, refusal ordering and cancellation. The rebuilt bundle SHA-256 was `585b6168978b0dcb52256e14c44b3ace4752441b8a8140b6af7e1b1d856d3906`.

## Limits and tradeoffs

Refresh may require one additional model call, but cannot exceed the original attempt count or deadline. Continued parent activity can still exhaust that bounded allowance and block the request. That is preferable to stale execution or unbounded retries.

The tests use deterministic offline transports and harmless sentinels. They establish control flow, release safety and diagnostics, not live model judgment quality or an explanation of the historical outage. Third-party and arbitrary nested dispatch remain outside the native harness coverage. No operator configuration, installed plugin, package version or release tag was changed.

## Shipping review follow-up

Independent review of `52ab7be` found two remaining diagnostic gaps. Official Jev responses with HTTP 200 and invalid JSON lost the observed status. Queued input and revoked permissions could be logged as ordinary progress.

Regression commit `75bb94b` reproduced four failures before the fix. The official parse error now preserves `response.status` without retaining the body. Authorization failures derive a bounded dimension from current guards instead of a mutable label left by an earlier refresh. Queued input is `pending_input`, and denied or missing permission is `permission`. Existing hard-change dimensions remain distinct.

The four regressions pass after the fix. Both workspace typechecks, source/bundle verification and the root test suite pass. Permission-system still passes 2761 tests. Safe-allow passes 591 tests with 32 skips. The original runtime evidence above describes its pinned historical source and is not a claim about a later bundle.
