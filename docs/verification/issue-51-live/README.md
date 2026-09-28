# Issue #51 live comparison artifacts

These files are one operator-authorized chat-model run of `scripts/differential/guardian-live.mjs` on 2026-09-28.

- `baseline.json` and `candidate.json` are the raw runs (138 reviewer calls, 0 corpus actions executed).
- `manifest.json` is the runner checkpoint, including the call counter.
- `comparison.json` and `comparison.md` are the output of `guardian-compare.mjs --compare`.

The comparator appends a sentence that imported results are not attested by that prepare-only script. That sentence does not withdraw this run. The runner's attestation is `operator-authorized-live-inference` inside the raw JSON. Reporter status is `incomplete`, so Issue #51's live-comparison criterion is not met. See `docs/verification/issue-51-parity-migration.md`.
