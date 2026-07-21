# pi-permission local fork (private)

Local fork of selected packages from [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages), customized for Windows Pi daily use.

## Packages

| Package | Path | Purpose |
|---|---|---|
| `@gotgenes/pi-permission-system` (fork) | `packages/pi-permission-system` | Plan B: authorizer `allow` capped only on `path` (not `external_directory`) |
| `pi-permission-safe-allow` | `packages/pi-permission-safe-allow` | Model judge for `external_directory` asks; may allow/deny/defer via light model + OAuth |

## Install into Pi (Windows)

```powershell
# 1) install prod deps for permission-system (once)
#    node_modules must include: zod, tree-sitter-bash, web-tree-sitter
#    (do not use monorepo catalog: with plain npm — see packages/pi-permission-system/FORK.md)

pi install "C:\Users\li.le.larry\Downloads\pi-packages-fork\packages\pi-permission-system"
pi install "C:\Users\li.le.larry\Downloads\pi-packages-fork\packages\pi-permission-safe-allow"

# optional: keep official typo judge
pi install npm:@gotgenes/pi-permission-model-judge
```

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
- This repo is private and for personal use; re-check licenses before redistributing.
