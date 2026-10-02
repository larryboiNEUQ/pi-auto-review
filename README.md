# pi-auto-review

Git-installable Pi package that ships two extensions together:

| Package | Path | Role |
|---|---|---|
| `@gotgenes/pi-permission-system` (fork) | `packages/pi-permission-system` | Deterministic allow / ask / deny boundaries and authorizer chain |
| `pi-permission-safe-allow` | `packages/pi-permission-safe-allow` | Codex-aligned delegated reviewer for eligible `ask`s |

One install loads **both** factories from this repository (no external permission plugin).

The root package exposes a **single** Pi extension entry (`./pi-entry.ts`, calling precompiled `./index.js`) so startup labels stay under the package folder. The bundle composes, in order:

1. in-repo `packages/pi-permission-system` (deterministic allow / ask / deny)
2. in-repo `packages/pi-permission-safe-allow` (delegated reviewer on eligible asks)

`index.js` is a **precompiled** ESM bundle of both factories (plus their TypeScript graph). Pi therefore does not jiti-transpile ~100+ `.ts` files on every process start. Rebuild after source changes with `npm run build`. No second package install or manual workspace link is required.

## v2.4.0

Aligns delegated review with Codex Guardian: provenance-aware evidence, bounded continuity and optional read-only investigation, browser continuation review, and independent per-call batch approvals on compatible Pi hosts. Repairs user-history admission, in-flight authority checks, reviewer routing and Jev authentication. Diagnostic logs stay out of the terminal by default; forwarded children cannot trip the parent breaker, and a stopped notice waits for the owning main-agent run to end and become idle.

对齐 Codex Guardian：支持带来源的评审证据、有界上下文复用、可选只读调查、浏览器续行评审，以及兼容 Pi 上的工具批次逐调用授权。修复用户历史取证、进行中的授权校验、评审调用路由与 Jev 认证。默认诊断不刷终端；子 agent 不影响父 agent 停止计数，停止提示只在所属主 agent 结束且空闲后显示。

[Release notes / 中英双语发布说明](docs/releases/v2.4.0.md). #60 and #61 remain separate follow-ups / #60、#61 保留为独立后续。

```shell
pi install https://github.com/larryboiNEUQ/pi-auto-review@v2.4.0
```

## v2.3.1

Ships the previously unmerged #37 work (#38). Reviewer infrastructure failures are reported as `unavailable` with a finite code and stay blocked, distinct from model or human denials. Tintinweb child approvals reach the root UI for top-level runs and for persisted nested sessions linked by an exact `parentSession` file chain; default in-memory nested runs stay fail-closed unless the default-off global `experimentalNestedForwarding` option is enabled, which may misroute when an unrelated nested session is active. Startup logs a `runtime.provenance` record with the loaded entry, package root, version, and commit.

Install this release with `pi install https://github.com/larryboiNEUQ/pi-auto-review@v2.3.1`.

## v2.3.0

Fixes forwarded approval requests losing the child's authoritative access intent (#43, #44), so eligible reviewer allows produce nonpersistent One-time Grants without unnecessary terminal confirmation. Missing or malformed facts remain fail-safe; recorded-policy denies and sensitive-path caps are unchanged. Includes a reproducible historical source/bundle investigation.

Install this release with `pi install https://github.com/larryboiNEUQ/pi-auto-review@v2.3.0`. This pins the package to the release tag; choose a newer tag explicitly when upgrading. Unmerged PR #38 development features are not included.

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
  "includeToolResults": true,
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
evidence retains bounded provenance-labeled authorization history and recent causal
tool calls/results. Textual tool results are included by default as redacted,
untrusted facts (never user grants). Set `includeToolResults: false` to opt out;
the omission is visible to the reviewer. This changes the previous default.
Hard request limits can block review rather than silently drop required context.
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
- The thin `pi-entry.ts` obtains the running Pi version through its loader; business code remains in committed `index.js` so Git install needs no build step. After editing TypeScript sources, run `npm run build` before commit.
- Single-call compatibility is tested on Pi `0.81.0`; per-call approval of tool batches requires native Pi `0.85.1` or newer. Node.js 22 or newer is required. No Pi patch is needed.
- Forked from packages in [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages); see `LICENSE` files.
- This fork is **not** an OS sandbox and does not claim Codex-equivalent containment.
