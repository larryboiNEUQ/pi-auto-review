# Issue #47 — bounded authorization and factual evidence

Source: Spec #45, following #46 at `f45fce3`. This issue changes only reviewer evidence and request admission. It does not implement persistent reviewer conversations (#49), browser resource semantics (#48) or capability investigation (#50).

## Evidence contract

`bounded-provenance-v1` keeps user history on Pi's active branch (including earlier grants/restrictions) rather than cutting at the most recent user turn. Recent assistant text and causal tool calls/results remain explicitly labeled as lower-trust evidence. Textual tool results are included by default, secret-redacted, bounded and associated with observed call IDs and the host-provided owning session when available. They cannot grant authority, including when they contain user-looking strings. `includeToolResults: false` removes them and records an opt-out omission. Hidden thinking is excluded. A compaction entry marks earlier user history as unavailable and fails admission; recovery across compaction belongs to #49.

Selection and request admission use bounded, documented **estimates**, not measured provider usage: one estimated token per two ASCII characters and four per non-ASCII code point. Omission/truncation diagnostics and final admission results carry counts/reasons but not raw conversation text into the audit. Chat requests use the selected review model's context limit with an output reserve; evaluation requests use a local 24k estimated-token cap because the provider does not expose a reliable window. If current action, policy or untruncated user/system history cannot fit, admission blocks before auth/inference/execution; optional non-user entries may be removed as call/result pairs with explicit markers. A prior user-history omission is never guessed benign.

Pi's `SessionManager.buildContextEntries()` supplies only active-branch entries; `getEntries()` would leak sibling-branch grants. It documents a genuine user message role and tool-result role; a host-mediated question answer has no independently verified special session-entry shape here. Therefore this change recognizes only a real host user entry as a user answer; a tool result that *claims* to be an approval remains untrusted tool evidence. It does not infer authority from arbitrary wrapper `sessionId` fields.

## Local verification

- `npm run check`: both packages pass.
- `npm test`: permission-system 2,630; safe-allow 323; differential 12 pass, one Windows-only skip. The safe-allow suite includes real dispatcher/Gate/Authorizer/terminal sentinel tests for both chat and evaluation backends, dossier request capture, opt-out, forged tool text, admission failure without executor effects, and narrow budget/provenance unit tests.
- `npm run build && npm run build -- --check`: committed bundle rebuilt from 139 source inputs and matches.
- `git diff --check`: passes after whitespace cleanup.

Independent read-only review found four concrete defects: sibling-branch grants leaked by `getEntries`, structural password redaction lost in tool-call serialization, CJK underestimated at four characters per token, and unsupported user content silently skipped. The implementation now uses `buildContextEntries`, redacts structured arguments, charges non-ASCII pessimistically, and blocks unsupported user content; targeted regression tests pass. A focused follow-up review is pending.

Independent review and exact-head macOS/Windows Git-install CI must be recorded on PR #52 and Issue #47 before completing this issue. No paid inference or live browser action is claimed.
