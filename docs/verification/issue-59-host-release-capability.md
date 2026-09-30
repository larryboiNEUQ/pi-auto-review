# Issue #59 — executor-release capability investigation

Investigated: 2026-09-30 UTC. Parent: Spec #45. Delivery branch: PR #52.
Review baseline: `078ba3fb55a851d5b4fdeff3b19a8f0694f5b868`.

**Status: externally blocked; delegated batch execution is NOT implemented.**
The investigation did not establish a supported host-owned executor-release
fence or universal safe pre-preparation scheduling contract. Production code,
permission configuration, provider/subagent implementations and the Guardian
batch gate are unchanged. No acceptance checkbox for parallel support is earned
by the tests in this report.

## Public seam and findings

The operator confirmed the seam: real Pi Agent dispatcher → real GateRunner /
AuthorizerSelection / PermissionPrompter chain → observable disposable executor
sentinel, including existing forwarded child wire tests. Controlled model
transports and human dialogs replace only external/UI boundaries. The baseline
for both Standards and Spec review is `078ba3f`.

| Runtime examined | Findings | Scope of executable evidence |
| --- | --- | --- |
| Workspace / CI pinned Pi `0.81.0` | The parallel dispatcher prepares siblings before releasing their executors. Its approval hook is in preparation, not a final authority recheck. | Real dispatcher, real permission chain, chat/Jev protective regressions and child forwarding cases. |
| Installed Pi and agent-core `0.99.1` | The active AgentSession wires extension `tool_call` into Agent `beforeToolCall`. Parallel preparation still precedes executor release. No supported extension-wide final authority hook or universal scheduling control was found. | Eight targeted tests use the actual installed Agent dispatcher through a temporary Vitest alias; this is not a full installed extension-loader or live-provider trial. |

Evidence locations for the inspected `0.99.1` distribution:

- `pi-coding-agent/dist/core/agent-session.js:293–325`: `_installAgentToolHooks`
  routes `beforeToolCall` to the extension `tool_call` event.
- `pi-agent-core/dist/agent-loop.js:411–453`: `executeToolCallsParallel` awaits
  preparation of each sibling, stores prepared executions, then releases them
  with `Promise.all`.
- `pi-agent-core/dist/agent-loop.js:481–531`: `prepareToolCall` validates arguments
  and awaits `beforeToolCall`; it then returns the prepared tool and arguments.
- `pi-agent-core/dist/agent-loop.js:568–576`: `executePreparedToolCall` invokes
  `prepared.tool.execute(...)` without a second authority hook.
- `pi-coding-agent/dist/core/extensions/types.d.ts:883–935`: `tool_call` can block
  or mutate inputs during preparation; later handlers can mutate those inputs
  without revalidation. A future release proof must bind the final executor
  arguments, not just an earlier input preview.
- `pi-agent-core/dist/agent-loop.js:366–395` and extension
  `types.d.ts:478–487`: core has sequential scheduling and registered tools have
  `executionMode`, but this does not expose an extension-wide scheduling control
  for tools the permission extension does not own.
- `pi-coding-agent/dist/core/agent-session.js:363–394`: nested `executeTool` calls
  have their own runner and hooks. Any host capability must cover this path as
  well; support must not be inferred from a top-level batch alone.

`ExtensionToolContext.tools` is an executor view supplied to an executing custom
**tool**, not a universal pre-execution extension event/decorator contract.
Replacing arbitrary built-in/dynamic tools, reaching into private Agent fields,
or wrapping a third-party provider/subagent is not the accepted host seam.

Inspected file SHA-256 values:

| File | SHA-256 |
| --- | --- |
| Installed `0.99.1` agent-core `dist/agent-loop.js` | `65def8c7f3fa01e38fe05467520efc8673c22ea8197833a3b04b29c8a60cb1e3` |
| Installed `0.99.1` coding-agent `dist/core/extensions/types.d.ts` | `b45102f45ea5d7da1f8b49c33c8aad8db6e867bf9e088d5ddb9d3a97614eebe5` |
| Workspace `0.81.0` agent-core `dist/agent-loop.js` | `55148586a8e499aebd4dff2a650a32ba4d56b3a7a0491c07ed1790d121ce07c0` |

These findings apply to these inspected versions/distributions. They are not a
claim about every future Pi release or all hypothetical host APIs.

## Executable counterexample, not support evidence

Three new characterization cases in
`packages/pi-permission-safe-allow/test/escalation.integration.test.ts` exercise
an existing **human terminal** approval path. Safe-Allow is disabled only inside
the isolated fixture, so no delegated batch approval is granted and no
production configuration or batch check is bypassed. The registered `bash`
sentinel never runs a shell: it only writes a disposable marker.

1. A obtains human Yes through the real permission chain.
2. B's human dialog stalls. The marker is still absent: no executor has run.
3. While B waits, the fixture either queues user input, changes the active branch
   or refuses B.
4. B is blocked. The actual dispatcher nevertheless invokes the already-prepared
   A and writes exactly `prepared-a:git status`.
5. No session rule is created and no reviewer/model inference occurs.

This is an intentional **negative-control characterization** of the existing
host boundary. Its passing assertion observes the unwanted release gap; it
must never be described as a green security fix. It does not assert that human
approval is an acceptable replacement for delegated batch review. If a future
host closes this gap, the characterization and this compatibility report must
be revisited rather than weakening the host to preserve the old observation.

The existing Guardian tests remain the production safety regression: multiple
or unknown batch provenance blocks before review, emits
`batch_release_unfenced` and exact single-call advice, and produces zero
executor effects. Forwarded tests check the **child's** batch attestation and
reject a parent-local single-call claim as proof of child execution. They do not
prove a child release fence or support child parallel execution.

## Reproduction and bounded results

From the repository root:

```sh
npm exec --workspace packages/pi-permission-safe-allow -- vitest run \
  test/escalation.integration.test.ts \
  -t 'host release capability characterization|does not execute a previously prepared batched Guardian call|reviews a forwarded child ask at the parent Guardian|denies a forwarded child ask at the parent Guardian'
npm run check
```

Pinned runtime: **8 passed / 217 deselected** in the 225-case file.
Installed `0.99.1` Agent dispatcher: **8 passed / 217 deselected**, using the same
command plus `--config /tmp/pi-auto-review-issue59-host-vitest.config.mjs`.
The temporary config keeps the workspace's `#safe`, `#src`, `#test` aliases and
sets `@earendil-works/pi-agent-core` to the installed host's `dist/index.js`.
It does not modify dependencies, the lockfile, production source or installed
extensions. To repeat elsewhere, create the same temporary Vitest configuration
with that machine's absolute workspace and host module paths.

An initial direct alias attempt failed before dispatch because `0.99.1` renamed
the public constructor transport option from `streamFunction` to `streamFn`.
Only the two batch probe construction sites now provide both names, preserving
the explicit controlled transport for both APIs. The corrected eight-case run
above is the capability evidence; the initial setup failures are not permission
failures or a host-security result. The rest of the `0.81.0` test suite is not
claimed to have run on `0.99.1`.

An earlier pinned protective-only selection passed **27 tests**: chat/Jev
single-call human revocation, Guardian batch rejection and child provenance.
Both package typechecks passed after adding the characterization. Full root
`npm test`: permission-system **134 files / 2,701 passed**; safe-allow
**16 files / 475 passed / 13 skipped**; differential **33 passed / 1 skipped**;
bundle-helper **4 passed**. `git diff --check` and `npm run build -- --check`
passed. The root and installed bundle remain byte-identical, **230,884 bytes**,
SHA-256 `1f092e951e56c25a9d7ecb4ef2c8d5c50e6e6dd0ee6cbc53755cc46ea1cbf481`.
Independent reviews and exact-head CI are recorded on #59 / PR #52 after push.
No live model-quality data was created or historical corpus evidence rewritten.

## Required external capability to unblock implementation

Pi must expose and document either:

1. A host-owned, blockable executor-release authorization hook, on every relevant
   top-level/nested/recovered dispatch path, after sibling preparation and all
   input mutation. Bind each approval to the owning session/branch, exact final
   action and authority/policy revision. Immediately before invoking the tool,
   fail closed on queued revocation, changed identity/policy, cancellation or
   invalidated batch state. There must be no unguarded await/reusable allow
   between the final authority check and invocation.
2. An equivalent host-owned safe pre-preparation scheduling contract that the
   permission extension can require for every applicable call. A mutex around
   reviewer requests or `executionMode` on one extension-owned tool is not this
   guarantee. Sequential preparation alone also needs a documented bound on the
   approval-to-execution interval and final-input/authority validity.

Forwarded children must implement the capability in their own host/executor
and attest their own exact call and release contract. Parent evidence or a
parent-side approval cannot mint that child proof. Unknown or unsupported
capabilities remain blocked with #58's single-call guidance.

Once that facility exists, resume #59 with a failing **safe-progress** regression
and red→green implementation at the confirmed seams. Cover sibling stalls,
queued revocation, branch/session/policy changes, cancellation, sibling failure,
chat/Jev and child identity; then record a harmless installed Pi trial with
loaded bundle identity and capability. Do not mark #59 complete or start
#51/#45 final live acceptance while this blocker remains, absent explicit
operator direction to change sequencing/scope.
