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
  denies always block; high risk requires medium-or-higher authorization and a
  narrow scope.
- Retries transient/model parse failures at most three times inside one
  90-second deadline. Auth, model, transport, prompt, parse, timeout,
  cancellation, and missing-evidence failures do not execute the action.
- Stops the current turn after 3 consecutive denials or 10 denials in the last
  50 reviews.
- `/approve` grants one exact denied action one reviewed retry. It is not a
  session rule or a broader permission grant.

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
weakening, and destructive actions. These model-visible rules do not replace the
code floor: critical or absolute-deny decisions always deny, and high risk still
requires medium-or-higher authorization plus narrow scope.

Evidence uses independent character budgets for user, assistant, system, and
tool-call categories so noisy calls cannot crowd out user intent. Tool results
are excluded by default because they are untrusted and often large. Set
`includeToolResults: true` only when their diagnostic value outweighs the added
prompt-injection surface; included results have their own budget and remain
secret-redacted.

### Sensitive path envelope

`pathEnvelopeMode` defaults to `"cap-allow"`. On a sensitive `path` ask, a
reviewer `allow` is downgraded to `defer`, so the normal human terminal still
decides. Deny and defer verdicts are unchanged. This whole-path cap is an
intentional local stricter-than-Codex product choice: Codex has protected paths,
but no feature named “path envelope,” and this package does not claim Codex or
OS-sandbox equivalence.

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

The interactive console stays quiet unless something exceptional happens
(`register.fail`, `config.issue`, `denial.circuit_breaker`, `review.failure`).
Set `PI_SAFE_ALLOW_VERBOSE=1` to print every event to the console while
debugging.
