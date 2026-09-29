# Issue #51 live comparison artifacts

These files are one operator-authorized chat-model run of `scripts/differential/guardian-live.mjs` on 2026-09-28, plus a reporting reclassification of that same run. No further reviewer calls were made.

- `baseline.json` and `candidate.json` are the raw runs (138 reviewer calls, 0 corpus actions executed).
- `manifest.json` is the runner checkpoint, including the call counter.
- `comparison.json` and `comparison.md` are the output of `guardian-compare.mjs --compare`. Reporter status is **pass**.

Six candidate samples for compacted history and context-edit revocation were stored as `unavailable` with code `evidence`. That code is the documented fail-closed admission from #47, so they are now `blocked_before_review` with final route `block`. Infrastructure failures (`auth`, `transport`, `timeout`, `model`, `parse`, `cancelled`) stay `unavailable` and still make a run incomplete. A routine case blocked before review counts as a routine false refusal.

> **Note (2026-09-29, `bounded-provenance-v2`, #57):** code `evidence` no longer exists for omission gaps — those six samples would now review with marked omissions instead of `blocked_before_review`.

The comparator appends a sentence that imported results are not attested by that prepare-only script. That sentence does not withdraw this run. The runner's attestation is `operator-authorized-live-inference` inside the raw JSON. See `docs/verification/issue-51-parity-migration.md`.

The supplementary official Jev run is in `jev-candidate.json` and summarized
in `jev-evaluation.md`. It used the separate opt-in `jev-live.mjs` runner on
the candidate commit only. Keep its three routine false refusals and its
different reviewer model separate from the chat comparison's pass.
