# pi-auto-review

Git-installable Pi package that ships two extensions together:

| Package | Path | Role |
|---|---|---|
| `@gotgenes/pi-permission-system` (fork) | `packages/pi-permission-system` | Deterministic allow / ask / deny boundaries and authorizer chain |
| `pi-permission-safe-allow` | `packages/pi-permission-safe-allow` | Codex-aligned delegated reviewer for eligible `ask`s |

One install loads **both** factories from this repository (no external permission plugin).

The root package exposes a **single** Pi extension entry (`extensions/pi-auto-review.ts`) so `pi list` / `pi config` show one plugin. That entry composes, in order:

1. in-repo `packages/pi-permission-system` (deterministic allow / ask / deny)
2. in-repo `packages/pi-permission-safe-allow` (delegated reviewer on eligible asks)

No second package install or manual workspace link is required. Runtime cost matches loading the two factories; there is no extra per-tool hot path.

## Install and update in Pi

Requires [Pi](https://github.com/badlogic/pi-mono) / `@earendil-works/pi-coding-agent` and **Node.js 22+**.

```shell
pi install https://github.com/larryboiNEUQ/pi-auto-review
```

Update later:

```shell
pi update https://github.com/larryboiNEUQ/pi-auto-review
```

This repository is **public**. Other machines can run the same `pi install` URL without GitHub authentication.

`pi list` only proves the source was recorded. To prove both extensions load (order + zero load errors) the way CI does:

```shell
npm run smoke:git
```

The smoke uses a temporary `PI_CODING_AGENT_DIR`, installs from a Git source, imports both extension factories, checks load order, and verifies safe-allow resolves this checkout’s workspace permission-system fork.

## Default chain

The bundled permission-system defaults its authorizer chain to include `safe-allow`. Operators may still set, in `~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
{
  "authorizerChain": ["safe-allow"]
}
```

Safe-allow config (optional): `~/.pi/agent/extensions/pi-permission-safe-allow/config.json`

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.4-mini",
  "timeoutMs": 15000,
  "disabled": false
}
```

Routine lifecycle logs stay out of the TUI; audit JSONL remains under the extension logs directory. Set `PI_SAFE_ALLOW_VERBOSE=1` for full console diagnostics. See [#1](https://github.com/larryboiNEUQ/pi-auto-review/issues/1) / [#2](https://github.com/larryboiNEUQ/pi-auto-review/issues/2).

## Issue tracker

Specs, research, and completed tickets live on **GitHub Issues** (not in-repo `.scratch`):

| Issue | Topic |
|---|---|
| [#4](https://github.com/larryboiNEUQ/pi-auto-review/issues/4) | Spec: Git install + Codex-aligned delegated approval |
| [#3](https://github.com/larryboiNEUQ/pi-auto-review/issues/3) | Research: Codex delegated-approval findings |
| [#5](https://github.com/larryboiNEUQ/pi-auto-review/issues/5) | Ticket: Git-installable Pi bundle |
| [#6](https://github.com/larryboiNEUQ/pi-auto-review/issues/6) | Ticket: Codex-aligned delegated approval |
| [#1](https://github.com/larryboiNEUQ/pi-auto-review/issues/1) / [#2](https://github.com/larryboiNEUQ/pi-auto-review/issues/2) | Quiet TUI logging |

## Notes

- Root `package.json` keeps `"private": true` so this monorepo is not published to npm; **Git install via Pi is the supported distribution path**.
- Targets Pi `0.81.0` and Node.js 22 or newer.
- Forked from packages in [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages); see `LICENSE` files.
- This fork is **not** an OS sandbox and does not claim Codex-equivalent containment.
