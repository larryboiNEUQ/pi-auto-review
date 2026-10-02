# Spec #45 — user authorization retention and hard-budget recovery

Follow-up to the final review of PR #52, based on head
`b1ddba0f286d8548f6ad2ff53af2213212847177`. This closes an evidence-selection
gap in Issues #47/#57. The decision is
[ADR 0011](../../packages/pi-permission-system/docs/decisions/0011-codex-user-history-budget-recovery.md).

## Failure and selected repair

Before the repair, an earlier host-user grant could exhaust the 80k-character
soft pool or the 100-entry selection cap. A later user restriction was then
omitted while the reviewer request still passed admission. The deterministic
failure is missing authorization evidence, not an observed live model allow or
an executed harmful action.

The repair retains every available host-user message, including all its text
parts in original order, during soft selection. Complete-request admission first
evicts optional non-user facts without splitting call/result pairs. If necessary,
it then shortens ordinary historical user text from oldest to newest, preserving
UTF-8-safe head/tail text with an explicit marker. Current action, parent
restrictions, required system instructions and policy are not shortened. An
unrecoverable or unknown request window blocks before inference/execution.

## Codex comparison evidence

The read-only study used Codex
`98072cf5f68a2959961d5aa0ef0c9a78d6db80d1` and audited relevant official source at
`ca466061d64f0b44f416135c7fd06aa7af850bbc`. ADR 0011 links the exact source
boundaries. Its algorithm runner directly executed unmodified profile,
truncation, enforcement and budget modules with protocol/transport adapters;
it did not build or run the full Codex CLI.

Ten deterministic Codex algorithm cases and nine Pi in-memory candidate cases
established these behaviors before the user selected implementation:

| Scenario | Old Pi selection | Selected alignment behavior |
| --- | --- | --- |
| Earlier grant consumes 80k, later revocation | Revocation omitted despite admission | Both retained before hard recovery |
| Latest long message with revocation at tail | Tail omitted by collection/selection | Full message retained under soft limits |
| More than 100 user messages | Older restriction can be omitted | All user messages retained under soft limits |
| Multiple text parts in a user message | Later restriction can be omitted | Parts retained in original order |
| Small chat window or Jev 24k local cap | Admission can block | Optional eviction and historical recovery can fit the request |
| Extremely long latest message, restriction in middle | Restriction can be omitted | Hard head/tail recovery can still omit the middle restriction, with a marker |

The last row is a known accepted limit, not a safety success claim. A missing
instruction and a correctly denying model response are different observations.
Pi uses its existing pessimistic admission estimator, has no Codex reviewer-host
compaction interface, and does not fabricate authenticated `Required` source
delivery proof for normal host-user messages. These are intentional limits on
the parity claim.

## Formal implementation verification

Implemented on `feat/spec45-guardian-alignment`, compared against the pre-repair
head above. Recorded local results on 2026-10-02:

| Check | Actual result |
| --- | --- |
| RED: dossier soft-retention seam | Original prohibition and latest multipart restriction missing before fix |
| RED: hard admission | Chat and Jev rejected recoverable old historical user evidence |
| RED: real dispatcher/gate | Four old-cap cases failed; disposable marker executor was released when controlled inference did not receive the restriction |
| GREEN: same dispatcher/gate cases | All four passed; actual chat/Jev requests contain all 12/101 user entries and the complete restriction; executor and native dialog never called |
| RED/GREEN: same-length edit in a truncated middle during review | Both backends initially allowed; both now block with `authorization_changed` |
| Admission, dossier and continuity focused tests | 41 passed, including UTF-8 head/tail integrity, latest-middle omission, final measured budget fit, paired eviction, source immutability and system/action protection |
| Full root `npm test` | permission-system: 2,740 passed; safe-allow: 516 passed / 31 skipped; differential: 33 passed / 1 Windows-only skip; bundle helpers: 4 passed |
| Native Pi 0.99.1 | Existing per-call/host-release cases: 22 passed; new retention/in-flight cases: 6 passed |
| `npm run check` | Both workspaces passed |
| Bundle rebuild and `npm run build -- --check` | 233,854 bytes / 148 source inputs; checked bundle matches source |
| `git diff --check` | Passed |

The authorization-change fence and continuity identity digest the complete
pre-admission host user/system evidence locally. A revision inside a shortened
middle therefore invalidates a pending reply and resets continuity even if the
sent fragments would be unchanged; full source text is not added to audit logs
or sent beyond the admitted request budget.

Bundle SHA-256:
`42135f403cb3ae0e63cd7c8379cf7701a9cdc54b265105b85a472ac84dedb2be`.

The standalone real-plugin 16-case runtime verification and exact-head remote CI
will be recorded after their completion. This note does not claim pending results.

No paid inference, external publication action or full Codex end-to-end run is
claimed by synthetic request-capture tests. Exact-head remote CI, if run, must be
recorded with its actual head and result before describing it as passing.
