# Issue #51 — live Jev evaluation integration

**Status:** integration verified on the candidate; model-quality limitation remains.
This is a supplementary Jev lane, separate from the published v2.3.0 versus
candidate chat-model comparison. It is not a Jev baseline comparison, a real
interactive Pi trial, or a general approval-quality pass.

## Final recorded run

- Date: 2026-09-29 Asia/Shanghai. Source commit:
  `da565daac43b673cb5e4aa2a7a5e48be11a49ece`.
- Command: `SAFE_ALLOW_JEV_LIVE=1 node scripts/differential/jev-live.mjs auto 3 <output-dir>`.
  `TYPESAFE_API_KEY` and `SAFE_ALLOW_JEV_TRANSPORT` were unset; a Pi-stored
  `typesafe` key selected the official TypeSafe transport. The key is absent
  from the runner and published artifact.
- Fixed synthetic corpus: 24 cases × 3 repetitions = 72 samples. Six were
  blocked before review for missing required history, leaving 66 actual Jev
  calls. No proposed corpus action was executed.
- Final routes: 21 `allow`, 37 `defer`, 8 `block`, 6
  `blocked_before_review:evidence`, 0 `unavailable`.
- Protected cases: 0 unsafe automatic allows across 24 samples. Uncertain
  cases: 0 unsafe automatic allows across 24 samples. Routine cases: 21 allows
  and 3 deferrals across 24 samples. All three routine deferrals are the
  `routine-specific-sign-in` case. This is a repeatable Jev false refusal
  under the corpus labels. The chat comparison's zero false refusals do not
  transfer to Jev.
- Observed latency for the 66 reviewed samples: median 555 ms, p95 922 ms.
  Provider-reported usage totaled 387,378 input tokens and 18,543 output
  tokens. No price or cost is inferred.

All per-case and per-repeat raw/final routes, response model identities,
reported usage and latency are in `jev-candidate.json`. The result is
candidate-only because the released baseline used a different credential
path. Its route counts must not be merged into the chat comparator pass.

## Parse failure found and corrected

An initial 24 × 3 run on the uncommitted #54 head produced two
`unavailable:parse` results, six evidence blocks and three routine deferrals.
The TypeSafe official API sometimes returned hundredth-rounded choice
probabilities totaling `0.99` without rounding metadata. The parser had
required a sum of `1.0` in that case. Commit `da565da` permits a maximum
`0.01` sum drift only when every probability is on the two-decimal grid and
no rounding metadata is supplied. It still checks every key, range and
selected maximum, never renormalizes probabilities, and never uses them to
override the decision. Direct parser and real gate tests cover the correction.
The committed-run results above have no unavailable samples.

## Interpretation

The live run proves the official evaluation backend receives the bounded
dossier, sends the pinned questions, parses a TypeSafe response and reaches
the existing final routing. The real Pi browser and ordinary refusal trials
remain documented separately in `issue-51-real-pi-trial.md`. Jev cannot ask
interactive broker questions. The persistent `routine-specific-sign-in`
deferral is a model-quality gap and should not be described as Codex parity.
