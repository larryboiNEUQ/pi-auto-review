# pi-permission-safe-allow

Minimal **allow-capable** authorizer for `@gotgenes/pi-permission-system`.

- Surface: **`external_directory` only**
- Verdicts: `allow` | `deny` | `defer`
- Fail-safe: timeout / parse error / unresolved model → **`defer`**
- Default model: `openai-codex` / `gpt-5.4-mini`

## Requires plan-B permission-system fork

Upstream caps authorizer `allow` on `external_directory` to `defer`.  
Use the local fork where only `path` remains excluded:

`../pi-permission-system` (see `FORK.md` there).

## Install

```powershell
pi install "C:\Users\li.le.larry\Downloads\pi-packages-fork\packages\pi-permission-safe-allow"
```

Chain in permission-system config:

```json
"authorizerChain": ["model-judge", "safe-allow"]
```

Order: typo **deny-first** (`model-judge`), then safe **allow** (`safe-allow`), then human.

## Config

`~/.pi/agent/extensions/pi-permission-safe-allow/config.json`

Defaults apply if the file is missing (provider/model above).  
Set `"disabled": true` to force-defer everything.

## Security note

With plan-B, a model `allow` on outside-CWD access is real. Keep prompts conservative and prefer `defer` when unsure.
