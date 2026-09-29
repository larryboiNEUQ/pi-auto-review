# pi-permission-safe-allow

Codex-aligned delegated approval reviewer for the bundled
`@gotgenes/pi-permission-system` fork.

The permission system remains the deterministic owner of `allow`, `ask`, and
`deny`. Routine policy allows never call this reviewer, and policy denies can
never be loosened. Each eligible `ask` is converted into a typed, secret-safe
dossier and reviewed before any human terminal is reached.

This package does **not** add an OS sandbox and does not provide Codex-equivalent
filesystem, process, or network containment. It aligns the approval-review
behavior only.

### Bounded reviewer investigation

`readOnlyProbes: true` enables the original single canonical MCP-target preflight.
To additionally let the **chat** reviewer request a missing local fact, set
`investigationEnabled: true` as a separate opt-in (default `false`). Both flags
must be true; `readOnlyProbes: false` is an absolute opt-out. Only the current
ask's attested in-cwd file path may be inspected (regular-file metadata or
at most 4 KiB of UTF-8 text), or the current cwd's `package.json` name/version.
The permission system rechecks `read`/explicit `path` rules; it refuses
symlinks, external paths, private-key/credential names, and oversized/binary
contents. No shell, generic tool/MCP call, network, mutation, or approval API
is exposed. Every accepted fact is untrusted, redacted, ask-bound evidence
audited before the next review; missing authority, revoked read/path policy
or audit failure blocks. The requested and canonical source paths travel with
each observation. There are at most two broker calls, three chat model calls,
and one shared `timeoutMs` deadline; each local fact wait is capped at 250 ms.
The deadline is rechecked after inference and final audit. Jev cannot request
interactive facts and receives only the original canonical-target
preflight when eligible, with the limitation explicit in its state. See
[`docs/verification/issue-50-bounded-investigation.md`](docs/verification/issue-50-bounded-investigation.md).

## Install

```shell
pi install https://github.com/larryboiNEUQ/pi-auto-review
```

The root package installs both extensions in the required order. The bundled
permission-system defaults its `authorizerChain` to `["safe-allow"]`; an
operator may disable the reviewer or replace that chain explicitly.

## Behavior

- Reviews Bash/exec, external paths, network, MCP, permission, file, and
  describable special-operation asks through the same authorizer seam.
- Trusted Skill selection that policy marks `allow` bypasses the reviewer;
  ask-state Skills are reviewed, and actions produced by any Skill still use
  their native permission surfaces.
- Sends exact action and policy facts, compact user-visible conversation/tool
  evidence, MCP annotations/account facts when supplied, and any exact prior
  denial override.
- Redacts credential fields and common token formats from reviewer prompts and
  JSONL audit events. Authentication presence/mechanism remains visible.
- Uses Guardian-shaped risk and authorization output. Critical and absolute
  denies always block. An ordinary successfully reviewed denial, including a
  non-critical high-risk authorization/scope floor, defers the same pending ask
  to the configured terminal authority. Interactive sessions show the native
  one-time/session/deny/reason prompt; subagents retain parent forwarding, and
  headless sessions retain the denying terminal.
- A native one-time approval continues only the pending call. A session approval
  records only the gate-suggested surface and pattern in ephemeral session rules;
  matching requests then bypass both reviewer and prompt until shutdown.
- `scope` remains the blast radius of the exact action in the dossier (one
  inspectable target versus an unbounded, many-target, or bundled payload). Task
  or issue width is not `scope` and must not raise `riskLevel`. A recorded
  long-session mislabel (`01a00d7a`) treated implement-task narrative as the
  judged object; that was a rule-gap, not a reason to loosen the floor.
- Retries transient/model parse failures at most three times inside one
  90-second deadline. Auth, model, transport, prompt, parse, timeout,
  cancellation, probe, audit, and missing-evidence failures deny directly and
  never fall through to user approval.
- Stops the current turn after 3 consecutive final hard-floor reviewer denials
  or 10 such denials in the last 50 reviews. An ordinary denial awaiting terminal
  resolution is not added to the retry-denial picker and cannot trip that circuit
  breaker.
- `/approve` presents recent eligible final denials and grants exact, one-shot,
  reviewed retries, individually or for all shown actions. It is not a session rule or a broader
  permission grant; ordinary denials normally use inline terminal escalation.

### Current-call human fallback

With the default `authorizerChain: ["safe-allow"]`, an ordinary reviewer denial
returns `defer` to the native terminal while the **original call remains pending**.
The operator does not need to open `/approve`, issue another tool call, or run a
second model review of that ask. Nothing executes before the native decision.

| Review outcome | Result |
| --- | --- |
| Valid allow | Existing non-persistent allow, subject to the path envelope |
| Valid non-critical, non-absolute deny | Native terminal decides the pending ask |
| High risk with insufficient authorization or broad scope | No automatic model allow; native human approval or denial |
| Critical risk or `absoluteDeny` | Block without human fallback |
| Reviewer timeout, error, invalid output, or other review failure | Block without human fallback |
| Deterministic policy deny or hard deny | Block before delegated approval |

A native one-time Yes continues the pending ask once; No, denial with a reason,
or dismissal blocks it. Fallback itself registers neither a retry override nor
a session grant. The existing session-pattern option remains an explicit user
choice, not the meaning of `defer`. Ordinary escalations are not recorded as
final reviewer denials (they stay out of `/approve` history) but do call
`recordNonDenial()`, which clears the consecutive hard-deny streak and advances
the rolling window so interleaved escalations cannot make the breaker trip early.

Custom authorizer chains retain their configured order: `defer` passes to the
next link rather than bypassing it. A tool call with several independent asks
may still encounter several gates; approving one ask does not skip the others.

Reviewer execution failures are different from an operator disabling automatic
review or a policy configuration that cannot be loaded. Those preexisting
configuration paths still use their documented terminal behavior.

### Reviewer model switching and persistence

The **reviewer model** is the provider/model used by safe-allow after the
permission system's deterministic `allow`/`ask`/`deny` routing delegates an
eligible ask. It is independent from Pi's main agent model: `/review-model`
never changes `/model`, and `/model` never changes the safe-allow reviewer.
Likewise, `/approve` is an exact-action, one-retry override; it is not a model
selector and does not change the authorizer chain.

Use these commands:

- `/review-model` opens the reviewer picker, then asks for `Session (default)`,
  `Project`, or `Global`. Escape at either picker makes no change.
- `/review-model provider/model` switches only this Session. The complete text
  after the first slash is the model ID, so namespaced IDs work.
- `/review-model provider/model --project` saves the pair in
  `<project>/.pi/extensions/pi-permission-safe-allow/config.json`.
- `/review-model provider/model --global` saves the pair in
  `$PI_CODING_AGENT_DIR/extensions/pi-permission-safe-allow/config.json` (or
  `~/.pi/agent/extensions/...` when that environment variable is unset).
- `/review-model show` reports the effective pair, its Session, Project, Global,
  or built-in source, and its current validation state without printing secrets.
- `/review-model reset` clears only the Session choice.
- `/review-model reset --project` or `reset --global` removes only `provider` and
  `model` from that layer and clears the Session choice immediately.

Resolution order is **Session > Project > Global > built-in default**. Project
and Global saves also switch the current Session immediately. Therefore, saving
Global while a Project override exists uses the new Global model now, but a new
session in that project resolves the Project model again. Scoped resets clear
the Session choice and immediately fall through the remaining layers.

Chat reviewer choices respect Pi's current model scope. The same picker also
includes the supported Jev reviewer, whose evaluation capability is independent
from Pi's main-model catalogue. A switch validates the selected backend and
resolves its authentication without sending a completion or evaluation. Persistent
updates atomically replace or remove only `provider` and `model`; all policy,
timeouts, probes, envelope settings, and other fields remain untouched. Missing
files are created. If the target is malformed JSON, is not a JSON object, or
cannot be written, the command names the scope and path and preserves both the
previous Session selection and target bytes. Repair the reported file manually
and rerun the command; the command never rewrites corrupt configuration.

A successful choice is used by the next invocation of the already registered
safe-allow authorizer; the chain is not re-registered. Session state is
**session-scoped**: it survives `/reload` and resume even if the current tree
branch tip predates the `/review-model` entry (restore reads the full session
history, not only `getBranch()`). A fork or clone inherits it. `/new` starts
without the old Session choice and resolves persistent layers again. Runtime authentication,
transport, timeout, parse, and model failures remain fail-closed, remain eligible
for the existing exact-action `/approve` workflow, and never trigger automatic
fallback or configuration mutation. Feedback uses notifications; no footer or
keyboard shortcut is installed.

### Jev reviewer (Gateway or official TypeSafe API)

Jev uses the same reviewer commands, scope picker, notifications, and native
permission prompts as other reviewer models. Select it in `/review-model` or use:

```text
/review-model vercel-ai-gateway/typesafe-ai/jev
/review-model show
/review-model vercel-ai-gateway/typesafe-ai/jev --project
/review-model vercel-ai-gateway/typesafe-ai/jev --global
```

For persistent configuration, use the existing provider/model fields:

```json
{
  "provider": "vercel-ai-gateway",
  "model": "typesafe-ai/jev"
}
```

The picker identity stays `vercel-ai-gateway/typesafe-ai/jev`. Transport is
selected separately and never falls through to a chat completion reviewer:

| Selection | Behavior |
| --- | --- |
| `TYPESAFE_API_KEY` set (default auto) | **Official** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`. Optional `TYPESAFE_JEV_MODEL` (`jev-latest` default, or pin `jev-1.13.0` / `jev-preview`). |
| Environment key absent; Pi `auth.json` has a `typesafe` API key | **Official** with the Pi-stored key. |
| Both official key sources absent | **Vercel AI Gateway** via Pi's `vercel-ai-gateway` provider-auth API and the pinned AI SDK `experimental_evaluate` path. |
| `SAFE_ALLOW_JEV_TRANSPORT=gateway` | Force Gateway even if an official key is present. |
| `SAFE_ALLOW_JEV_TRANSPORT=official` | Force official HTTP; requires either official key source or validation/runtime auth fails closed. |

To use Pi's credential store, add this entry to `~/.pi/agent/auth.json` (or the
`auth.json` under `PI_CODING_AGENT_DIR`), preserving other entries:

```json
"typesafe": { "type": "api_key", "key": "<your TypeSafe API key>" }
```

Pi's `readStoredCredential("typesafe")` reads this entry. Use a literal key;
`!command` references are unsupported and fail closed. Store credentials in
Pi's auth file, never in Safe-Allow `config.json`. Existing installations are
not changed automatically. Auto selection checks the environment key first,
then this Pi credential, then Gateway. A malformed Pi credential or unreadable
credential store fails closed with an authentication error. The picker and audit
name the selected route and key source without showing the key.

Docs for the official API: https://www.jevtypesafeai.com/how-to-use

Jev is not added to Pi's `/model` catalogue, and installing this feature does not
change the default reviewer. An unavailable key is reported through the same
validation flow as other models. Successful local validation confirms capability
and credentials, not provider billing, availability, or judgment quality.

Internally, both transports evaluate the same redacted exact-action dossier and
effective Guardian policy using the same typed `choice` questions
(`guardian-jev-v3`). Answers supply risk, authorization, verdict, scope, absolute
denial, and an explanation category. The displayed explanation is generated from
those categories, not a free-form model rationale. Missing or invalid answers
fail closed; probabilities are not converted into a new approval threshold. The
existing Guardian floors and authorizer chain apply as they do for chat
reviewers. Ordinary refusals reach the native terminal; technical failures,
critical risk, and absolute denials remain blocking. Audit events record
`jevTransport` as `gateway` or `official`, and `jevKeySource` as `env`,
`pi-auth`, or `gateway`.

Gateway mode uses a pinned AI SDK release with SDK retries disabled. Official
mode uses a single HTTP round-trip and maps HTTP/auth/parse failures to the same
fail-closed review codes. The reviewer's existing attempt budget, deadline, and
cancellation govern both paths. A failed evaluation never silently switches
transport mid-request and never silently switches to a chat reviewer.

To switch back, select another reviewer with `/review-model`. To remove a saved
Jev default, use `reset --project` or `reset --global` for each layer you changed;
plain `reset` only clears the Session override. Before downgrading to a version
without Jev support, restore a supported provider/model pair and clear any saved
Jev Session selection. Reverting code alone does not change stored choices.

For an optional live smoke check, use a disposable project and fresh Pi session,
select Jev for the Session only, and request a harmless read of a synthetic local
fixture whose permission policy is explicitly `ask`. Inspect the reviewer audit
for the Jev identity, evaluation contract, and `jevTransport`, then reset the
Session. This uses Gateway or TypeSafe quota and verifies connectivity and
routing only; never use production data or treat one successful classification as
an approval-quality benchmark. Automated CI instead uses synthetic state and
controlled provider responses.

### Approving denied retries

Run `/approve` to open a concise, newest-first menu. Labels lead with an
ordinal, normalized risk, and action surface; rationale and action previews are
secret-redacted and bounded. Long literal shell chains emphasize consequential
steps and report how many other steps were omitted. Internal denial/request IDs
and timestamps are intentionally absent from the picker (direct
`/approve <denial-id>` remains supported for diagnostics and scripts).

```text
#1 [HIGH] Shell — Remote mutation needs approval. — git commit … → git push origin main (+4 steps)
#2 [MEDIUM] File — Writes outside the project. — write ~/.config/tool/settings.json
──────── Approve all shown (2 exact retries)
```

**Approve all shown** appears only when the menu contains at least two unique
exact actions. “Shown” means the current bounded recent-denial snapshot (at
most 10 records), not older or future actions. Duplicate records for the same
exact action count once and create only one pending override.

Neither an individual nor bulk selection executes, queues, or retries anything.
Ask the agent to retry separately. Each matching override is exact-action scoped,
consumed once, and presented to the reviewer on that retry; deterministic denies,
Guardian floors, path envelopes, and all other safeguards still apply.

### Deterministic opaque-shell re-gates

An ask matched by the built-in `<opaque-bash-wrapper>` rule can avoid model
review only when its command is a faithfully decomposable literal wrapper or
chain and every resulting leaf has a recorded `allow`. Supported wrappers are
`eval` and the shell basenames `bash`, `sh`, `dash`, `zsh`, and `ksh`, including
slash-qualified shell paths. Shell wrappers must use a short flag cluster that
contains `c` (for example, `-c` or `-ec`) followed by one single- or
double-quoted payload. Literal chains split on top-level `&&`, `||`, and `;`;
separators inside balanced quotes remain part of the leaf.

Each leaf re-enters the injected permission query as a Bash command with the
current agent name. That query retains the permission system's session and
current-working-directory policy. A recorded `deny` always denies the wrapper,
including a deny found after an earlier `ask`. A residual `ask`, uncertain
decomposition, or an ask from any pattern other than `<opaque-bash-wrapper>`
continues through the existing authorizer-chain review and fail-closed behavior.

Dynamic payloads (including `$` and command substitution), nonliteral payloads,
malformed quoting or escaping, empty chain leaves, and unsupported syntax never
receive a silent allow. This is approval routing through the existing authorizer
chain, not a new model entrypoint or an OS sandbox.

### Budgeted read-only dossier probes

Set `readOnlyProbes: true` to let an incomplete MCP ask resolve a missing canonical
target before model review. Eligibility is deliberately narrow: the dossier must be an
otherwise exact ask missing only `action.target`, with a known MCP server, tool, inert
JSON-like plain argument record, and no redaction markers. Accessors, cycles, custom
prototypes, dangerous keys, symbols, functions, undefined values, and non-finite
numbers fail closed without invoking getters or probing.

The probe path receives only the injected `permission.target.resolve` canonicalization
query; it has no policy-evaluation, tool-execution, registration, or mutation capability.
A null target, resolution error, cancellation, exhausted hop budget, timeout, or
unwritable probe audit event denies without model or terminal execution. Successful
results enter both the dossier and `probe.completed` audit event exactly as returned,
labeled as untrusted, permission-system canonical target-resolution evidence. The full
Guardian model review then runs normally, including critical, absolute-deny, and
high-risk code floors.

The fixed allowlist performs at most one lookup. `probeMaxHops` defaults to 1; zero
exhausts the budget before querying, and positive values are capped at 1.
`probeTimeoutMs` defaults to 1,000 ms and is capped at 5,000 ms. The timeout
bounds asynchronous settlement cooperatively; it cannot preempt event-loop-blocking
synchronous code. These
in-process probes provide no filesystem, process, network, or OS sandbox
containment.

## Config

`~/.pi/agent/extensions/pi-permission-safe-allow/config.json`

Defaults work without a file. Starting with the `guardian-outcomes-v2` default
policy, low and medium intrinsic risk default to **allow regardless of user
authorization**, except when an explicit policy prohibition applies or affirmative
evidence shows malicious prompt injection instructing an unrelated action.
High risk requires medium-or-higher semantic authorization and narrow scope;
critical risk and absolute prohibitions deny. The model judges the exact action's
effects rather than the task's size or command syntax. Unknown read results are
not unknown executable payloads. Login state, escalation, or external-directory
location alone do not raise intrinsic risk. `guardian-outcomes-v3` adds browser
and computer-use rules: nested actions are judged by actual effects and selected
inputs, not tool names. All websites are untrusted unless the effective policy
explicitly marks them trusted; a familiar domain or existing login confers no
trust. Ordinary navigation under an existing login is not high alone, but signing
in is high and needs specific authorization. Unrelated private content is high;
permission expansion and consequential submission need specific authorization,
and sensitive egress is critical absent explicit approval of the exact data and
destination. Editable drafts are distinct from submitted effects.
Available resource IDs, URLs, source call/session, ordering and lifecycle results
are untrusted observations, not grants or guaranteed current state; missing or
stale associations must be qualified. Requested URLs do not prove navigation,
although an explicit committed-navigation receipt may establish partial success
despite a later timeout. Read-result uncertainty is not unknown outgoing payload,
and read-named tools are not automatically safe. The bundled policy still covers
data exfiltration, credential probing, persistent security weakening, and
destructive operations. Pi code retains stricter critical/absolute and high-risk
floors, deterministic permission denies, the sensitive-path envelope, and
ordinary model-denial escalation to human approval. It does not override a
completed low/medium reviewer deny or grant reusable authorization.

Migration from `guardian-outcomes-v1`: no stored custom policy or reviewer model
is rewritten. Check `review.routed`/`review.decision` for the effective policy
version and SHA-256 policy hash. A configured `policyPath` remains authoritative,
so the new default thresholds do not guarantee parity under custom policy.
Rollback by pinning the prior extension release or setting `policyPath` to the
previous policy; restore the prior `instructions` setting as well if you
customized it. The next evidence-contract migration below changes the previous
latest-user-only window and opt-in result default; pin the previous release if
those older evidence defaults are required for rollback. This update adds browser
rules only to the built-in default policy and Jev question instructions; it does not
rewrite operator-supplied `policy`, `policyPath`, or `instructions`. Existing custom
policies remain authoritative, and deterministic code floors remain unchanged.

Evidence now retains bounded genuine user messages on the active, compaction-aware
Pi branch (including earlier grants and restrictions), and recent causal
assistant/tool-call/result facts. Tool results are **included by default** as
redacted, untrusted facts with available call identity; they cannot grant
permission. Set `includeToolResults: false` to opt out explicitly. The dossier
marks omitted or truncated evidence, including the opt-out, rather than
assuming missing evidence was benign. Under `bounded-provenance-v2` (#57),
unsupported user media, compacted older history, branch-local context edits
and truncated instructions are signaled to the reviewer in-band: a compaction
summary is included only as derived, untrusted evidence that cannot grant or
attest authorization, and a host-generated completeness notice lists every
omission reason and count. Admission fails closed only when the request
itself is unbounded — an unknown reviewer context limit, or mandatory
evidence alone exceeding the window after optional eviction. The admission estimate
charges one token per two ASCII characters and four tokens per non-ASCII code
point; it is deliberately pessimistic, not measured provider tokens. Jev uses
a 24k estimated-token local cap, not a claim about the provider window. A
request that cannot fit its mandatory current action and authorization context
blocks before inference. Browser fixture coverage and its limits (mock routing
is not model-quality evidence) are recorded in
`docs/verification/issue-48-browser-evidence.md`. The effective reviewer
model and policy retain the same authorization chain.

Reviewer continuity is **bounded, in-memory context assembly**, not a provider
prompt cache, a reusable allow, or a session permission. A chat reviewer first sees
the full admitted request; if the host session, active branch, model, policy
and authorization prefix still match, later requests carry an admitted
historical-evidence prefix, new evidence delta and **only the current exact
action**. Jev always receives its full assembled bounded snapshot. Missing or
invalid cursors, forks, changed user restrictions, model or policy, and budget
overflow rebuild a full request; missing mandatory history still blocks before
inference. Reload/resume reconstructs from the host's active branch rather than
persisting raw reviewer evidence. Queued user steering blocks a review before
it is persisted; a changed branch, policy or admitted facts during inference
invalidate that review. Terminal fallback remains available for ordinary denial,
but an approval made while its dialog waited is rejected if the host session,
active branch or pending-user-input state changed before the gate releases the
action. Only genuine host-user entries can establish user authorization.
Pi prepares every call in a parallel assistant tool batch before executing any
prepared call; it exposes no cancellable pre-executor authorization hook. Guardian
requires **affirmative originating single-call proof** from the host's active
assistant message. Multi-call, missing-ID or unmatched asks fail closed before
inference or terminal escalation. A subagent without UI forwards its asks to the
parent, where they are reviewed like local asks. The parent
cannot see the child's transcript, so the child attests its batch from its own
active branch on the forwarded request (`batchProvenance`); a single-call
attestation is reviewed normally, while a multi-call, unknown or missing
attestation (for example from an older child) fails closed the same way a local
batch does. Ordinary single-call denials still reach terminal authority.
Deterministic permission decisions outside Guardian retain their existing behavior.

### Sensitive path envelope

`pathEnvelopeMode` defaults to `"cap-allow"`. On a sensitive `path` ask, a
reviewer `allow` is downgraded to `defer`, so the normal terminal still decides.
An ordinary reviewer denial now also defers under the general escalation rule,
while critical/absolute denials and all reviewer failures remain direct denials.
This whole-path allow cap is an intentional local stricter-than-Codex product
choice: Codex has protected paths, but no feature named “path envelope,” and this
package does not claim Codex or OS-sandbox equivalence.

Operators who want the reviewer to decide those asks can set
`"pathEnvelopeMode": "honor-reviewer"`. That opt-out honors reviewer allows
only after deterministic routing reached `ask`; it cannot loosen deterministic
policy denies, hard-deny rules, critical/absolute Guardian floors, or the
high-risk authorization and scope floor.

To replace the model-visible policy without changing code, set `policyPath`:

```json
{
  "policyPath": "./guardian-policy.md"
}
```

Relative paths resolve from the `config.json` directory, so the example reads
`guardian-policy.md` beside that file. Global config loads first; a project
`.pi/extensions/pi-permission-safe-allow/config.json` policy overrides it. An
unreadable, empty, or invalid policy path emits a `config.issue` and disables
automatic review for that config, deferring asks to the terminal authorizer
instead of silently using a different policy.

`instructions` remains available for reviewer-role/output-format customization;
use `policyPath` for organization outcome rules. Policy text can make rules
stricter, but cannot loosen deterministic permission denies or the code floors.
Set `includeToolResults: false` to opt out of bounded, secret-redacted tool output.
Set `readOnlyProbes: true` to opt into the fixed one-lookup, non-mutating metadata
allowlist; use `probeMaxHops` and `probeTimeoutMs` within the hard caps described above.
Enable `investigationEnabled: true` only after explicitly authorizing the
additional local read capability; the default is `false`. To roll back, set
`investigationEnabled: false` (or `readOnlyProbes: false` for all probes).
Existing custom policy, reviewer selection, and deterministic gates remain
unchanged. A capability-limited broker is **not** OS containment; concurrent
local filesystem mutation remains a documented residual risk. Native Windows
network-share targets are denied, but preflight checks on a mapped drive can
still cause network filesystem I/O; no zero-network-I/O guarantee is made.
Set `pathEnvelopeMode: "honor-reviewer"` to opt out of the safer default
sensitive-path allow cap; omit it or use `"cap-allow"` to keep terminal review.
Set `disabled: true` to hand asks back to the normal terminal authorizer.
`timeoutMs` is one finite per-ask deadline shared by preflight, auth, model,
and fact calls; `maxAttempts` is capped at 3, and interactive rounds use
one attempt each.

## Logging

At extension load, the `runtime.provenance` record identifies the executing
entry path and the containing `pi-auto-review` package root and version. It also
includes the full Git commit when the loaded installation's own Git metadata
provides one; unavailable values are recorded as `"unknown"`. This evidence is
read from the loaded bundle's location and its adjacent package/Git metadata,
not from Pi settings or a development checkout. To inspect startup records:

```shell
jq -c 'select(.event == "runtime.provenance")' \
  "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-permission-safe-allow/logs/safe-allow.jsonl"
```

Routine lifecycle events (`session_start`, `register.ok`, `register.skip`,
`session_shutdown`, …) are written only to the JSONL audit log under
`~/.pi/agent/extensions/pi-permission-safe-allow/logs/safe-allow.jsonl`. A
successful probe records labeled, secret-safe evidence in `probe.completed`; if
that event cannot be written, review fails closed before the model runs. Probe
failures use `review.failure` with a `probe_*` code and budget metadata, without
executing the action.

Every routed review records Guardian policy version and effective policy SHA-256,
evidence-contract identity, omission/truncation counts and reasons, and whether
a probe supplied evidence. Full conversation/tool-result text is not written
to the audit. Final reviewer decisions additionally record attempt count, risk,
authorization, and verdict. Ordinary denials carry `escalated: true` and
`escalation: "terminal_authority"`; the permission system separately records
the eventual human or denying-terminal decision with its native provenance.
`review.continuity` records `full`/`delta`/`reset`/`snapshot` with a reason
but no retained transcript, and `authorization_changed` fails closed when an
in-flight review sees different live context before returning its decision.

The interactive console stays quiet unless something exceptional happens
(`register.fail`, `config.issue`, `denial.circuit_breaker`, `review.failure`).
Set `PI_SAFE_ALLOW_VERBOSE=1` to print every event to the console while
debugging.
