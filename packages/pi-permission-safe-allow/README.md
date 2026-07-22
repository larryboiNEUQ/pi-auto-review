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
pi install https://github.com/larryboiNEUQ/pi-permission-local-fork
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

## Config

`~/.pi/agent/extensions/pi-permission-safe-allow/config.json`

Defaults work without a file. Set `disabled: true` to hand asks back to the
normal terminal authorizer. `timeoutMs` is the total review deadline;
`maxAttempts` is capped at 3.

## Logging

Routine lifecycle events (`session_start`, `register.ok`, `register.skip`,
`session_shutdown`, …) are written only to the JSONL audit log under
`~/.pi/agent/extensions/pi-permission-safe-allow/logs/safe-allow.jsonl`.
The interactive console stays quiet unless something exceptional happens
(`register.fail`, `config.issue`, `denial.circuit_breaker`, `review.failure`).
Set `PI_SAFE_ALLOW_VERBOSE=1` to print every event to the console while
debugging.
