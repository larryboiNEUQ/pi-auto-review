# Local fork notes

**Base:** `@gotgenes/pi-permission-system@20.9.1` from [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages)  
**Version label:** `20.9.1-larry.b1`  
**Location:** `~/Downloads/pi-packages-fork/packages/pi-permission-system`

## Plan B change

File: `src/authority/delegation-envelope.ts`

| Surface | Upstream | This fork |
|---|---|---|
| `path` | authorizer `allow` → forced `defer` | same (still capped) |
| `external_directory` | authorizer `allow` → forced `defer` | **allow allowed** (not capped) |
| other surfaces (e.g. bash) | allow OK | same |

## Install into Pi

```powershell
pi remove npm:@gotgenes/pi-permission-system
pi install "C:\Users\li.le.larry\Downloads\pi-packages-fork\packages\pi-permission-system"
```

Config (authorizer chain) still lives in:

`~/.pi/agent/extensions/pi-permission-system/config.json`

An allow-capable judge is still required for auto-allow; this fork only removes the hard cap on `external_directory`.

Companion package (same monorepo checkout):

- `packages/pi-permission-safe-allow` — link name `safe-allow`, reviews `external_directory` with a light model and may return `allow` / `deny` / `defer`.

Recommended chain:

```json
"authorizerChain": ["model-judge", "safe-allow"]
```

## Upgrade upstream later

Rebase/cherry-pick onto newer `packages/pi-permission-system` and re-apply the envelope change.

## Local runtime deps (required)

Upstream monorepo uses `catalog:` for devDeps; plain `npm install` fails.
For local path install into pi, run once:

```powershell
# from temp install then copy, or after stripping catalog from package.json:
cd C:\Users\li.le.larry\Downloads\pi-packages-fork\packages\pi-permission-system
# ensure node_modules has: zod, tree-sitter-bash, web-tree-sitter
```

Safe-allow needs a junction:

```powershell
# packages/pi-permission-safe-allow/node_modules/@gotgenes/pi-permission-system -> ../pi-permission-system
```
