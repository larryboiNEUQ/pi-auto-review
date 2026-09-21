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
- `/approve` remains compatible for exact final denials and grants one exact
  denied action one reviewed retry. It is not a session rule or a broader
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
choice, not the meaning of `defer`. Repeated ordinary escalations do not count
as final reviewer denials for the circuit breaker.

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
safe-allow authorizer; the chain is not re-registered. Session state survives
`/reload` and resume, and a fork or clone inherits it. `/new` starts without the
old Session choice and resolves persistent layers again. Runtime authentication,
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
| `TYPESAFE_API_KEY` unset | **Vercel AI Gateway** via Pi's `vercel-ai-gateway` provider-auth API and the pinned AI SDK `experimental_evaluate` path. |
| `SAFE_ALLOW_JEV_TRANSPORT=gateway` | Force Gateway even if `TYPESAFE_API_KEY` is present. |
| `SAFE_ALLOW_JEV_TRANSPORT=official` | Force official HTTP; requires `TYPESAFE_API_KEY` or validation/runtime auth fails closed. |

Docs for the official API: https://www.jevtypesafeai.com/how-to-use

Jev is not added to Pi's `/model` catalogue, and installing this feature does not
change the default reviewer. An unavailable key is reported through the same
validation flow as other models. Successful local validation confirms capability
and credentials, not provider billing, availability, or judgment quality.

Internally, both transports evaluate the same redacted exact-action dossier and
effective Guardian policy using the same typed `choice` questions
(`guardian-jev-v1`). Answers supply risk, authorization, verdict, scope, absolute
denial, and an explanation category. The displayed explanation is generated from
those categories, not a free-form model rationale. Missing or invalid answers
fail closed; probabilities are not converted into a new approval threshold. The
existing Guardian floors and authorizer chain apply as they do for chat
reviewers. Ordinary refusals reach the native terminal; technical failures,
critical risk, and absolute denials remain blocking. Audit events record
`jevTransport` as `gateway` or `official`.

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

Defaults work without a file. The bundled Guardian policy has explicit outcome
rules for sensitive-data exfiltration, credential probing, persistent security
weakening, and destructive actions. It defines `scope` as exact-action blast
radius and states that session narrative may change `userAuthorization` only.
These model-visible rules do not replace the code floor: critical or
absolute-deny decisions always deny, and high risk still requires
medium-or-higher authorization plus reviewer-emitted narrow scope.

Evidence is the current user grant for this ask plus later turns. Independent
character budgets for user, assistant, system, and tool-call categories still
prevent a noisy call from erasing that grant. Earlier session narrative is not
the judged object. Tool results are excluded by default because they are
untrusted and often large. Set `includeToolResults: true` only when their
diagnostic value outweighs the added prompt-injection surface; included results
have their own budget and remain secret-redacted.

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
Set `includeToolResults: true` to opt into bounded, secret-redacted tool output.
Set `readOnlyProbes: true` to opt into the fixed one-lookup, non-mutating metadata
allowlist; use `probeMaxHops` and `probeTimeoutMs` within the hard caps described above.
Set `pathEnvelopeMode: "honor-reviewer"` to opt out of the safer default
sensitive-path allow cap; omit it or use `"cap-allow"` to keep terminal review.
Set `disabled: true` to hand asks back to the normal terminal authorizer.
`timeoutMs` is the total model-review deadline; `maxAttempts` is capped at 3.

## Logging

Routine lifecycle events (`session_start`, `register.ok`, `register.skip`,
`session_shutdown`, …) are written only to the JSONL audit log under
`~/.pi/agent/extensions/pi-permission-safe-allow/logs/safe-allow.jsonl`. A
successful probe records labeled, secret-safe evidence in `probe.completed`; if
that event cannot be written, review fails closed before the model runs. Probe
failures use `review.failure` with a `probe_*` code and budget metadata, without
executing the action.

Every routed review records the model-visible Guardian contract version, a
SHA-256 hash of the effective policy text, and whether a probe supplied evidence.
Final reviewer decisions additionally record attempt count, risk, user
authorization, and verdict. Ordinary denials carry `escalated: true` and
`escalation: "terminal_authority"`; the permission system separately records the
eventual human or denying-terminal decision with its native provenance. All
fields remain secret-redacted, and policy text itself is not logged.

The interactive console stays quiet unless something exceptional happens
(`register.fail`, `config.issue`, `denial.circuit_breaker`, `review.failure`).
Set `PI_SAFE_ALLOW_VERBOSE=1` to print every event to the console while
debugging.
