# pi-auto-review

Git-installable Pi package that ships two extensions together:

| Package | Path | Role |
|---|---|---|
| `@gotgenes/pi-permission-system` (fork) | `packages/pi-permission-system` | Deterministic allow / ask / deny boundaries and authorizer chain |
| `pi-permission-safe-allow` | `packages/pi-permission-safe-allow` | Codex-aligned delegated reviewer for eligible `ask`s |

One install loads **both** factories from this repository (no external permission plugin).

The root package exposes a **single** Pi extension entry (`./index.js`, built from `./index.ts`) so startup labels stay under the package folder. That entry composes, in order:

1. in-repo `packages/pi-permission-system` (deterministic allow / ask / deny)
2. in-repo `packages/pi-permission-safe-allow` (delegated reviewer on eligible asks)

`index.js` is a **precompiled** ESM bundle of both factories (plus their TypeScript graph). Pi therefore does not jiti-transpile ~100+ `.ts` files on every process start. Rebuild after source changes with `npm run build`. No second package install or manual workspace link is required.

## v2.2.0

Adds the Jev Safe-Allow reviewer via Gateway and the official TypeSafe API, routes ordinary escalations to the native terminal, and fixes Session reviewer restoration (#36). Also adds a readable `/approve` picker and bulk exact retry authorization (#30).

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
  "policyPath": "./guardian-policy.md",
  "timeoutMs": 90000,
  "includeToolResults": false,
  "pathEnvelopeMode": "cap-allow",
  "readOnlyProbes": false,
  "probeMaxHops": 1,
  "probeTimeoutMs": 1000,
  "disabled": false
}
```

`policyPath` is optional and resolves relative to this config file. Put the
organization policy beside the config (or use an absolute path). If the file
cannot be read, safe-allow reports the config issue and defers to the terminal
authorizer rather than reviewing under an unintended policy. The shipped default
covers exfiltration, credential probing, persistent weakening, and destruction;
evidence uses independent user/assistant/tool-call budgets, and tool results are
excluded by default to limit injection surface and token waste. Opt in with
`includeToolResults: true`; included results are separately budgeted and redacted.
Code-enforced critical/absolute/high-risk floors remain authoritative.

`pathEnvelopeMode` defaults to `"cap-allow"`: even when safe-allow approves a
sensitive `path` ask, the grant falls through to the human terminal. This is an
intentional stricter-than-Codex product envelope, not a Codex feature or an OS
sandbox claim. Set `"pathEnvelopeMode": "honor-reviewer"` to opt out and honor
the reviewer's allow; deterministic policy denies and Guardian code floors still win.

Optional `readOnlyProbes` can complete an otherwise exact MCP dossier missing only
its target through the injected non-mutating canonical target-resolution query. Probe
evidence is labeled as `permission.target.resolve`, untrusted, secret-safe, and audited
before the full Guardian review. The fixed allowlist performs at most one lookup;
`probeMaxHops: 0` disables that lookup for fail-closed budget testing, and positive
values are capped at one. The timeout defaults to 1,000 ms and is hard-capped at
5,000 ms. Null resolutions, errors, budget exhaustion, timeouts, and audit failures
deny without execution. Accessor-bearing or otherwise non-JSON MCP arguments are
ineligible without invoking accessors. The cooperative in-process deadline
cannot preempt event-loop-blocking synchronous code and provides no OS sandbox or
process/network containment.

Routine lifecycle logs stay out of the TUI; audit JSONL remains under the extension logs directory. Set `PI_SAFE_ALLOW_VERBOSE=1` for full console diagnostics. See [#1](https://github.com/larryboiNEUQ/pi-auto-review/issues/1) / [#2](https://github.com/larryboiNEUQ/pi-auto-review/issues/2).

## Recommended routing profile

The versioned [`codex-auto-v1.json`](packages/pi-permission-system/config/codex-auto-v1.json) profile allows routine in-tree file work and a curated set of read-only/test bash commands without model review. Outside-CWD access, network-capable or ambiguous bash, and MCP calls remain `ask`; sensitive paths and the built-in hard-deny baseline remain local denials.

See the [adoption and migration guide](packages/pi-permission-system/docs/migration/codex-auto-v1.md) for copy commands, the looser/tighter comparison with `config.example.json`, and the executable verification matrix. This changes deterministic **routing** (when an ask reaches review), not safe-allow **review quality** (how an eligible ask is judged), and it is not an OS sandbox.

Global operators can extend deterministic hard-deny with organization-specific path or bash rules by including `"$defaults"` in `hardDeny`. Project hard-deny rules are trust-gated and tighten-only: untrusted project additions are ignored, while trusted additions append without replacing the global baseline. See the [operator recipes](packages/pi-permission-system/docs/configuration.md#hard-deny-composition).

## Release differential

The dedicated **Release differential** workflow runs on manual dispatch and future `v2.*` tag pushes under Node 24. Its automatic contract compares `v1.0.0` with the pushed v2 tag; manual runs accept exact v-prefixed SemVer tags and default to `v1.0.0` and `v2.0.0`. It resolves each tag once, records the exact commit SHA, creates a detached worktree for each commit, runs `npm ci --ignore-scripts` against that tag's committed lockfile, and executes that checkout's public root `index.js` in a separate child process and isolated `PI_CODING_AGENT_DIR`. Public tool-call results, `permissions:decision` events, safe-allow review/probe event counts, and explicit model-attempt observations are classified as compatibility invariants or expected v2 improvements. Model attempts are the sum of numeric `attempts` fields on public-audit `review.decision` JSONL records; a model-registry lookup is not treated as inference.

Run the same fixed-tag comparison locally:

```shell
npm run test:differential
```

Override exact v-prefixed SemVer release tags or the output directory with `--old-ref`, `--new-ref`, and `--output-dir`. The command owns only `old-results.json`, `new-results.json`, `comparison.json`, and `comparison.md` in that directory; unrelated caller content is preserved. All four paths remain available with diagnostics or placeholders after a failed materialization, install, version run, comparison, or cleanup. A cleanup failure replaces any successful comparison artifact with failure evidence and returns a nonzero exit. Every successful result records its resolved commit, and both SHAs appear in the comparison evidence. Every observed decision field, including v2's `routingSource`, every safety outcome, and independently expected zero review events, model attempts, and probe events are checked against fixed literals. The existing `v2.0.0` tag predates this workflow and must be compared by manual dispatch; it is not moved or rewritten.

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
- Host APIs (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`) are **peerDependencies** only. Pi’s Git install runs `npm install --omit=dev` and resolves those through the extension loader — the package must not re-embed the full Pi/LLM SDK tree into `node_modules` (that was inflating install size to hundreds of MB and slowing Windows startup).
- Commit the built `index.js` so Git install does not need a build step on the operator machine. After editing TypeScript sources, run `npm run build` before commit.
- Targets Pi `0.81.0` and Node.js 22 or newer.
- Forked from packages in [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages); see `LICENSE` files.
- This fork is **not** an OS sandbox and does not claim Codex-equivalent containment.
