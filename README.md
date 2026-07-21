# pi-permission local fork (private)

Local fork of selected packages from [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages), customized for Windows Pi daily use.

## Packages

| Package | Path | Purpose |
|---|---|---|
| `@gotgenes/pi-permission-system` (fork) | `packages/pi-permission-system` | Plan B: authorizer `allow` capped only on `path` (not `external_directory`) |
| `pi-permission-safe-allow` | `packages/pi-permission-safe-allow` | Model judge for `external_directory` asks; may allow/deny/defer via light model + OAuth |

## Install and update in Pi

```shell
pi install https://github.com/larryboiNEUQ/pi-permission-local-fork
pi update https://github.com/larryboiNEUQ/pi-permission-local-fork
```

The repository is one Pi package source. Pi clones it, installs the locked runtime
dependencies, and loads `pi-permission-system` before `pi-permission-safe-allow`.
No second package install or manually created dependency link is required.

`pi list` confirms that the Git source was recorded, but it does not prove that
the extensions loaded. To perform the same isolated install/load/update smoke
used by CI:

```shell
npm run smoke:git
```

The smoke uses a temporary `PI_CODING_AGENT_DIR`, asks Pi's public resource
loader to import both extension factories, checks the exact load order and zero
load errors, and verifies that safe-allow resolves this checkout's workspace
permission-system fork. The temporary directory is removed after a passing or
failing run.

The repository is private. Authenticate GitHub for `git` before installing; do
not put a token in the source URL because Pi persists that URL in settings.

In `~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
"authorizerChain": ["model-judge", "safe-allow"]
```

Safe-allow config: `~/.pi/agent/extensions/pi-permission-safe-allow/config.json`

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.4-mini",
  "timeoutMs": 15000,
  "disabled": false
}
```

## Notes

- Upstream monorepo history is retained where sparse-checkout included it.
- The Git bundle targets Pi `0.81.0` and Node.js 22 or newer.
- This repo is private and for personal use; re-check licenses before redistributing.
