# Local fork notes

**Base:** `@gotgenes/pi-permission-system@20.9.1` from [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages)  
**Version label:** `20.9.1-larry.b1`  
**Location in this repository:** `packages/pi-permission-system`

## Plan B change

The combined personal Git bundle treats installation as explicit
delegated-review opt-in and defaults `authorizerChain` to `["safe-allow"]`.
Set the chain to `[]` to restore terminal-only approval. This intentionally
supersedes upstream ADR 0007's empty-chain default for this bundle only.

File: `src/authority/delegation-envelope.ts`

| Surface | Upstream | This fork |
|---|---|---|
| `path` | authorizer `allow` → forced `defer` | same (still capped) |
| `external_directory` | authorizer `allow` → forced `defer` | **allow allowed** (not capped) |
| other surfaces (e.g. bash) | allow OK | same |

## Install into Pi

```shell
pi install https://github.com/larryboiNEUQ/pi-auto-review
```

The repository root installs this package and its safe-allow companion as one
locked workspace bundle. Do not install the package directory separately.

Config (authorizer chain) still lives in:

`~/.pi/agent/extensions/pi-permission-system/config.json`

An allow-capable judge is still required for auto-allow; this fork only removes the hard cap on `external_directory`.

Companion package (same monorepo checkout):

- `packages/pi-permission-safe-allow` — link name `safe-allow`, reviews every
  eligible `ask` with a typed secret-safe dossier and returns decisive
  `allow` / `deny`; operational failures deny fail-closed.

Recommended chain:

```json
"authorizerChain": ["safe-allow"]
```

## Upgrade upstream later

Rebase/cherry-pick onto newer `packages/pi-permission-system` and re-apply the envelope change.

## Runtime dependencies

Pi runs the root lockfile during Git installation. It installs this package's
`zod`, `tree-sitter-bash`, and `web-tree-sitter` dependencies and creates the
safe-allow workspace relationship automatically. No manual junction or
post-clone dependency command is required.
