# Issue #48 — browser and computer-use evidence

## Policy contract

The built-in Guardian policy and Jev question instructions assess browser/computer actions generically, including recursively nested JavaScript, by actual effects, selected inputs, destinations, and observed results. Navigation under an existing login and task-relevant session metadata are not high risk alone. Unrelated private content is high; permission expansion and consequential external effects require specific authorization; sensitive egress to an untrusted/unresolved destination is critical without explicit approval of both exact data and destination. Draft edits are distinguished from submission. Unknown read output is not an unknown outgoing payload, and read-named tools are not automatically safe.

Dossier tool receipts remain bounded, secret-redacted, causally associated facts with call IDs and the host-provided owning **Pi session** when available; that label does not verify ownership of a remote browser account. A browser receipt may report opaque handles, resource/page/space identifiers, URL, lifecycle and ordering, but these facts are untrusted observations—not authority or guaranteed live state. No association is inferred from the requested URL/planned call alone. Missing or contradictory session/space associations, redirects, stale/closed targets and ownership changes must be qualified. An explicit receipt saying navigation committed followed by a load timeout can represent partial success; an argument or timeout alone cannot. This issue does not implement a trusted browser-state normalizer or persistence.

No browser adapter, command whitelist, verdict postprocessor, or live remote operation is introduced. Custom policy/instructions remain untouched and authoritative; deterministic permission and reviewer floors are unchanged.

## Synthetic Gate fixture matrix

`escalation.integration.test.ts` runs **separate current actions** through the real Gate/Authorizer/terminal harness with `describe.each(["chat", "jev"])`: each case supplies its own user request, bounded prior receipts and structured pending `browser_action` input. Scripted model risk/verdict results establish request routing (including ordinary denial through the native terminal, and critical denial without terminal escalation) and evidence capture only—not live-model judgment. A separate Agent-dispatcher sentinel for both backends proves a synthetic browser action executes once only after allow, and never after denial; its executor writes only a disposable local marker. Browser tool names in session evidence are inert and cannot perform remote actions.

| Fixture/evidence | Expected observable coverage |
| --- | --- |
| User URL then opaque handle receipt | Causal call/result, observed handle/resource/URL and host-provided Pi session survive into reviewer request; no remote-account ownership is inferred |
| Missing/wrong session or space; redirect; stale/closed handle; ownership change | Contradictory or unavailable facts reach the reviewer; scripted denials route to native terminal, but no browser-state mapping is derived or proven |
| Committed navigation then load timeout | Preserve explicit partial-success facts; requested URL alone is not proof |
| User-modified draft vs submitted form | Actual state/effect distinguished; consequence not hidden by assistant intent |
| Explicit `includeToolResults: false` | Results omitted and omission diagnostics preserved |
| Existing-login navigation and specifically authorized sign-in versus unapproved sign-in | Existing login alone does not raise risk; sign-in requires specific authorization, high-risk narrow approval remains possible |
| Unrelated private page, familiar but untrusted SaaS egress, permission expansion, form submission | Each exact pending action and causal receipt reach both backends; scripted high denials escalate to native terminal, critical denials block |
| Nested JavaScript claiming “inspect only” but with POST/submission/credential effects | Nested effects included; wrapper intent does not sanitize |
| Unknown read receipt vs outgoing payload | Separate classifications, neither blanket fail-open nor automatic deny solely for unread result |
| Secret-bearing browser receipt | Redacted before model request/audit; no full private page in audit |

The existing causal-evidence and opt-out tests also run for both backends. Both reviewer request formats include the effective built-in browser policy; a configured custom policy replaces it without being rewritten. `guardian-outcomes-v3` and `guardian-jev-v3` distinguish the new model-visible contracts from the prior versions, including when a custom policy hash stays unchanged. The matrix asserts each pending input and the exact call/result IDs in order, but scripted answers do **not** demonstrate live-model policy compliance. A harmless live ego-browser continuation belongs to the final acceptance issue and is not required here.

## Verification

Independent review found four defects in the initial slice: omitted default-untrusted domains, omitted sign-in rule, mixed narrative fixture without individual pending-action routing, and unchanged contract identities. The revised policy, scenario-specific Gate matrix and versioned audits address them. `npm run check`, `npm test` (2,630 permission-system, 376 safe-allow, 12 differential; one Windows-only skip), `npm run build && npm run build -- --check` (139 inputs), and `git diff --check` pass in the dedicated issue worktree. Merged-PR-worktree verification and exact-head macOS/Windows CI remain required before #48 closes. No live browser operation or paid model judgment is claimed.
