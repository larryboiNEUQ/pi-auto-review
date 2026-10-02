# Issue #58 — daily-use review failures and safe recovery

Parent: Spec #45. Delivery branch: PR #52. Related future behavior: #59.

## Observed failures (2026-09-29 UTC)

This investigation correlates session tool-call IDs to audit request IDs, not just adjacent timestamps. No raw transcripts, provider errors, credentials or hidden reasoning are copied into this report.

| Session | Precisely correlated observations | Diagnosis |
| --- | --- | --- |
| `01a0ee93-af94-735f-a753-398dc2bd30d3` | Six failures at 19:12:10, 19:12:34, 19:15:00 and 19:16:07; affected calls belonged to three/four-call assistant batches. At 19:17:32 the same harmless printf inspection was sent alone, reviewed by devin/swe-2 and completed. | All six audit failures were `batch_release_unfenced`, provenance `multiple`, not model verdicts or admission failures. |
| `01a0ed9f-2ced-765d-ac92-a7d63266c367` (this conversation) | Nine failures in three three-call batches at 19:22:15, 19:23:59 and 19:24:51; they persisted through reviewer switching/reload. | All nine exact-ID matches were also `batch_release_unfenced` / `multiple`, without reviewer admission for those requests. |

The previous hypothesis that this conversation was blocked by an evidence-window overflow was incorrect. Both sessions received `failed (evidence)` and service-recovery advice because the reviewer collapsed the batch subtype and the Gate reformatted its more specific guidance away. The #55 system-budget/provider fixes and #57 marked-omission contract do not remove this deliberate batch restriction.

A nearby audit record at 19:16:40 reports a forwarded `authorization_changed`. Its request ID is absent from the target session's direct tool calls; this report does not attribute it as one of the six failures or claim its underlying invalidation was erroneous. Resolving legitimate forwarded-review staleness requires a separately correlated child/parent trace. Startup MCP/dependency warnings are not these auto-review failures.

## Repair boundaries

- Preserve `batch_release_unfenced` and `authorization_changed` as finite failure codes in the existing `reviewer_failure` / `reviewer_unavailable` envelope.
- Provide locally authored exact-action recovery advice at the final Gate, without passing arbitrary denial/provider strings through as feedback. Genuine `evidence` failures direct the operator to admission/failure diagnostics instead of promising a service-recovery fix.
- The outer approval-epoch guard also uses the authority-change classification. A regression discovered its pending-input failure previously appeared as `User denied`, although no user clicked No. Both pre-chain and late-release invalidations still block exactly as before, including invalidation of human approvals. The envelope denotes inability to release a valid approval, not proof of a model call.
- Keep batch rejection, user revocation, deterministic denies, terminal fallback for ordinary completed refusals, output redaction and executor effects unchanged.
- #59 owns safe batch progress: it needs a host-proven executor-release fence or equivalent pre-preparation scheduling contract. A reviewer mutex alone does not stop a stale prepared call being released after a sibling waits.

## Verification

Primary seam remains the real Agent dispatcher → Gate → registered reviewer/Authorizer chain → tool result and disposable executor sentinel, with controlled transport/UI.

1. Red: `npm exec --workspace packages/pi-permission-safe-allow -- vitest run test/escalation.integration.test.ts -t 'does not execute a previously prepared batched Guardian call'` failed on both chat and Jev: expected `failed (batch_release_unfenced)`, received `failed (evidence)` and service-recovery advice.
2. Green: the same dispatcher test reports the batch code/single-call advice while proving zero executor calls. Gate-chain tests cover fresh exact single-call retries, pending-input block/retry and inadmissible chat/Jev requests. Existing real-dispatcher human-approval tests additionally check that revocation/queued steering returns `authorization_changed`, not a user refusal, with no executor effects or session grants.
3. Gate event tests retain finite subtypes and strip a synthetic Bearer error from tool feedback. Existing outage/parse/auth and ordinary-denial tests remain green.
4. Both package typechecks passed. Full root `npm test`: permission-system 134 files / 2,701 passed; safe-allow 16 files / 472 passed, 13 skipped; differential tests 33 passed, one Windows-only skip; bundle helper tests four passed and bundle contract verified.
5. Root validation initially caught a pre-existing v1 assertion in the differential harness: it expected compaction to block before review. With operator approval, this assertion now verifies v2 reviewer reachability, marked omissions, derived/untrusted summary and zero action dispatch, using a controlled high-risk refusal. The corpus's `not-allow` label and historical live artifacts are unchanged; this is not new live model-quality evidence. The targeted differential test passed all three cases.
6. Rebuilt committed extension: 230,884 bytes / 146 inputs. Exact-head CI is recorded in the issue/PR after push.

The user's YOLO setting made this investigation possible; it is not a fix or a validation of approval routing. This change does not modify the user's permissions, chosen reviewer or installed bundle. Production acceptance after installing/reloading the new bundle remains separate from these controlled tests.
