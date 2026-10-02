# Quiet reviewer feedback and stop ownership

Parent: Spec #45. Related diagnostic/failure ownership: Issues #57/#58.
Implementation baseline: `d9dcf5e5f066ce3b20772f410fbfd8e84efbb384`.
Acceptance: the user discussion of 2026-10-03, including the explicit requirement
to show a stopped notice only after confirming that the owning main agent has
actually stopped. Decision:
[ADR 0012](../../packages/pi-permission-system/docs/decisions/0012-quiet-review-feedback-and-stop-ownership.md).

## Failure and accepted behavior

The baseline printed selected diagnostic objects through `console.warn`, so
reviewer failures appeared in the same terminal as Pi's ongoing agent work.
It also notified before requesting `abort()`, and forwarded child outcomes
could affect the parent's repeated-denial counter. A diagnostic failure, a
blocked tool call and a stopped main-agent run are separate observations.

| Situation | Expected agent feedback | Expected terminal presentation |
| --- | --- | --- |
| Reviewer failure or invalidated authorization | Existing blocked tool result and recovery guidance | No raw diagnostic event |
| Ordinary refusal requiring native approval | Existing pending-call human fallback | Existing approval UI only |
| Forwarded child allow, hard refusal or human fallback | Existing child/parent result path; no parent counter changes | No parent stopped notice |
| Local main-agent hard-refusal threshold reached | Existing local stop protection requests cancellation | No stopped notice while the agent is still running |
| That owning run has ended and is confirmed idle | Existing denied-call result remains intact | One brief Pi UI stopped warning |
| Expected registration race or retry miss | Existing registration retries | No warning |
| Final registration failure or actionable configuration issue | Existing failure/configuration behavior | Brief deduplicated Pi UI notice |
| Explicit diagnostic debugging enabled | Existing tool and approval behavior | Secret-redacted diagnostic details |

All diagnostic events still attempt JSONL recording; existing audit-write
failures continue to block where required. Permissions, reviewer model choice,
refusal floors, retry behavior and terminal authority are unchanged. No Pi
settings edit or configuration migration is required.

## Formal verification

Verified in an isolated checkout on 2026-10-03; no running user session or Pi
settings were changed.

| Check | Observed result |
| --- | --- |
| Logger RED → GREEN | Three baseline failures; three passes after repair. Default console output is zero; JSONL is retained; debug details are redacted; unavailable audit path still returns false. |
| Forwarded ownership RED → GREEN | Baseline: six failures and two local controls passed. Repaired: all eight chat/Jev cases passed through the actual extension registration. Child hard refusals cannot stop the parent; child allow/defer cannot reset the parent streak. |
| Extension lifecycle and actionable notices | 82 cases passed across chat/Jev, including end-before-idle, context wrappers, another session, run/session/tree replacement, final registration failures, quiet delayed success and grouped configuration issues. |
| Real native stopped-run timing | On unmodified Pi 0.99.1, the baseline notified while idle was false. The repaired observation is `agent_end: idle=false → stopped notice: idle=true inside agent_settled → settled observer: idle=true`. The same controlled fixture passed twice. |
| Full root suite | Permission-system: 2740 passed; safe-allow: 546 passed / 32 skipped; differential: 33 passed / one Windows-only skip; bundle helper: four passed. The native-only stopped-run fixture is one default-suite skip and is explicitly exercised below. |
| Permanent native selection | 23 passed on Pi 0.99.1: existing dispatcher/host capability 22 plus the new stopped-run timing case. Non-selected dispatcher cases are outside this focused run. |
| Loaded bundled plugin | 16 controlled CLI cases passed, including the owned RPC-parent/SDK-child forwarding path with peer SDK 0.81.0. |
| Build, typecheck and review | `npm run check`, `npm run build -- --check` and `git diff --check` passed. Standards and Spec reviews each found zero actionable findings. The second review axis reused the read-only review agent after a separate delegation hit the agent thread limit. |

Reproducible commands:

```sh
npm run check
npm run build -- --check
PI_CODING_AGENT_DIR=/tmp/pi-merge-review-52/pi-test-profile npm test
PI_AUTO_REVIEW_TEST_HOST_ROOT=/tmp/pi-merge-review-52/native-pi-0991/node_modules/@earendil-works/pi-coding-agent \
  npm exec --workspace packages/pi-permission-safe-allow -- \
  vitest run --config ../../scripts/native-pi-vitest.config.mjs
node scripts/verify-per-call-batches.mjs \
  --pi-root /tmp/pi-merge-review-52/native-pi-0991/node_modules/@earendil-works/pi-coding-agent \
  --peer-root ./node_modules/@earendil-works/pi-coding-agent \
  --output /tmp/pi-merge-review-52/quiet-repair-runtime-receipt.json
```

Committed bundle: 234871 bytes, 148 inputs, SHA-256
`9cd3e768c901d52180377aa384d19b87dd2f7326a3e79fc967c9a728fa9b7503`.
The real native fixture uses a harmless tool and deterministic transport; it
exercises actual session cancellation and extension event timing, without a
live model call. The loaded-plugin cases cover top-level batches and owned
two-session forwarding, not third-party or nested dispatch.

These deterministic fixtures establish routing, stop ownership and visible
feedback. They do not claim live model judgment quality or that an extension
update has already been loaded into the user's running Pi session.
