# Issue #59: per-call batch approval and explicit stop

The user revised #59 on 2026-10-01: each tool call is approved independently;
refusing one call does not cancel its siblings. Ordinary queued input need not
invalidate the entire batch. Pi's explicit stop/abort cancels calls that have not
started, and completed effects are not rolled back. A universal authority fence
or atomic batch is no longer required. Pi and third-party plugins remain unmodified.

## Supported behavior

- Native Pi **0.85.1 or newer** can review a proven tool-call batch. Each allow,
  denial, terminal fallback and reviewer failure belongs to its exact action.
- Pi 0.85.0 introduced the prepared executor closure's `signal.aborted` check;
  0.85.1 is the first usable SDK release after the 0.85.0 import packaging fix.
  Real dispatcher tests cover 0.85.1 and 0.99.1, rather than assuming support.
- An earlier approved A is still prevented from executing if Pi is explicitly
  stopped while B is waiting for approval. Cancellation during reviewer inference
  and during the final decision audit also yields zero sentinel effects.
- Known batches on compatible originating hosts may continue with ordinary
  queued input. Single/unknown/older-host asks retain their existing pending-input
  invalidation. Changed owner, branch, policy, admitted evidence and explicit
  cancellation still invalidate an in-flight approval.
- Multiple calls on older/unknown hosts, and unknown batch provenance, remain
  `batch_release_unfenced`. Retry the exact action alone or update the originating
  host. A new reviewer, reload, wildcard allow or reusable grant is not needed.
- A forwarded request carries child-attested `batchProvenance` and `hostVersion`.
  The parent never substitutes its local transcript or version. Old/missing child
  version blocks a child batch while existing single-child calls remain compatible.

## Host identity and distribution

Real CLI verification exposed a version-skew hazard: a native ESM `index.js`
import can resolve `VERSION` from the plugin's own dependencies rather than the
executor host. The old worktree with Pi 0.81.0 dev dependencies reported 0.81.0
while actually running Pi 0.99.1; reversed skew could incorrectly admit old hosts.

The thin **`pi-entry.ts`** is now the single Pi discovery entry. Pi's TypeScript
loader supplies its aliased `VERSION`, which the entry passes explicitly to the
precompiled `index.js` factory. Batch-related production modules do not read an
imported/local SDK version. Direct factories without an attested host version
fail closed for batches. The business graph stays precompiled; Git installation
still needs no build step and no Pi patch.

This contract uses Pi's standard TypeScript extension loader. It does not add
an executor hook or claim OS sandboxing, whole-batch revocation on one refusal,
or revalidation of all authority immediately before every execution. Already
running tools retain their existing cooperative cancellation behavior.

## Verification

The accepted test seam is real Agent dispatcher → real Gate / Authorizer /
Permission chain → a disposable marker executor. Controlled model transports
and UI isolate external boundaries; the dispatcher is never replaced by a mock.

- Baseline regression: on native Pi 0.81.0, force a strict zero-effects assertion
  after A's approval and B's wait, call real `agent.abort()`, then release B.
  The assertion fails because A writes its marker. The explicit legacy negative
  control preserves that observable limitation.
- Native Pi **0.85.1** and **0.99.1** each pass **22 selected scenarios**: chat/Jev
  all-allow, sibling denial, queued input, reviewer failure, ordinary denial → terminal Yes/No, cancellation during review/final audit/terminal wait,
  plus human-terminal dispatch characterizations. Every cancellation scenario
  has zero executor calls; denial leaves only the permitted sibling's effect.
- Child version/provenance isolation is checked at the forwarded-file reader,
  request server, parent reviewer and chain guard. Missing/old child versions
  cannot borrow the compatible parent's capability.
- `.github/workflows/git-bundle-smoke.yml` keeps the Pi 0.81.0 macOS/Windows
  single-call and Git-install checks, and adds native 0.85.1/0.99.1 batch jobs.

Reproduce native tests after installing an unmodified Pi separately:

```sh
PI_AUTO_REVIEW_TEST_HOST_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent \
  npm exec --workspace packages/pi-permission-safe-allow -- \
  vitest run --config ../../scripts/native-pi-vitest.config.mjs
```

`testNamePattern` deliberately selects the native batch and host characterization
scenarios. The ordinary full suite continues to use the pinned Pi 0.81.0 and
includes its unsupported-host protection; skipped new-host cases are exercised
in the separate native jobs.

## Real loaded-plugin trial (2026-10-01)

`node scripts/verify-per-call-batches.mjs` exercises the unmodified real Pi CLI
and loader. A loopback OpenAI-compatible fixture supplies fixed task/reviewer
responses; this proves integration and cancellation, not live model judgment.
Each test executor writes a disposable marker unconditionally: it has no
`signal.aborted` guard that could hide an unsafe host release.

| Actual Pi | Extension's local SDK dependency | Cases | Result |
|---|---|---:|---|
| 0.99.1 | 0.99.1 | 6 | Top-level and owned parent/child forwarding pass |
| 0.99.1 | 0.81.0 | 6 | Same behavior; real host correctly identified |
| 0.81.0 | 0.99.1 | 1 | Two calls blocked before review; zero review/marker effects |
| 0.85.1 | 0.85.1 | 6 | Minimum supported version passes |

The six supported-host cases are all-allow, mixed allow/deny, and explicit stop
while B's review waits after A was allowed, both locally and with a real RPC
parent/SDK child using the plugin's file forwarding. They produce respectively
2, 1 and 0 markers. The child's own stop still prevents execution when the
parent's held approval subsequently returns allow. Wire records prove the
child's host version and `multiple` provenance. CLI/bundle bytes are unchanged
by each run. These owned two-session tests do not claim a new third-party
`tintinweb/pi-subagents` or nested-dispatch E2E result.

Raw receipts stay local and are not uploaded as CI artifacts.
The verified bundle SHA-256 is
`f27bdc296ee3ffdb8cc3d2e711aeed00ec4583aa8bc979b85c9207c4d26861bc`;
the thin entry SHA-256 is
`f56a1cd79d0f5b10fa85763c9c24d6dace2053f3e5c62c1627b7805128531bd1`.

For example, with a separately installed host:

```sh
node scripts/verify-per-call-batches.mjs --pi-root /path/to/pi-coding-agent \
  --peer-root ./node_modules/@earendil-works/pi-coding-agent --output /tmp/batch-receipt.json
```

Both native CI versions run this real loaded-plugin/forwarding trial. The
0.99.1 job also checks reverse dependency skew against the workspace's older Pi.
Standards and Spec review against `f097e79` have no residual findings after
adding native batch terminal-fallback, reviewer-failure and late-Yes cancellation
coverage. Local full suites passed: permission-system 2728; safe-allow 497,
plus the differential and bundle contracts. Native jobs separately cover the
new-host cases skipped by the legacy pinned suite.

## Earlier investigation

The former #59 contract required a universal final authority fence. At baseline
`f097e7941b4434b15ecc377b543a8953f31fe5a2`, both inspected Pi versions lacked that
extension API, so delegated batches were deliberately blocked. Real human-terminal
negative controls showed A could still execute after queued input, a changed
branch or a sibling denial. Those findings remain valid evidence of per-call,
nontransactional behavior; they are not a blocker for the revised explicit-stop
contract. The installed 0.99.1 closure already supplied the cancellation check.
