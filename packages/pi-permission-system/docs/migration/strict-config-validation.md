# Migration guide: strict config validation

Starting with the release that closes #547, the permission-system config loader validates each config file against a JSON Schema derived from a zod source of truth.
This is a **breaking change** in how malformed config is handled.

## What changed

The loader used to be **tolerant**: it silently discarded a malformed field and loaded the rest.
For example, a config with `"debugLog": "yes"` (a string, not a boolean) simply dropped `debugLog` and kept going; an unknown key like `"debugLo": true` was ignored.

The loader is now **strict and fail-closed**:

- A config file with **any** invalid field is rejected as a whole scope (global or project).
- The rejected scope contributes **no** permission rules, so its surfaces fall back to the safe universal `ask` default — never `allow`.
- Each problem is reported as a clear, path-qualified issue in the permission review log (and the debug log when `debugLog` is on).

Nothing about the config **format** changed — a config that was already valid keeps working unchanged.

## What you need to do

If your config was valid, nothing.

If a scope stops taking effect after upgrading (surfaces start prompting with `ask`), open the permission review log and look for `Invalid config value at '<path>': …` or `Unrecognized config key '<key>'.` messages.
Fix each reported problem, then reload.

Common fixes:

- **Wrong type** — e.g. `"toolInputPreviewMaxLength": "400"` (string) → `400` (number); `"debugLog": "true"` → `true`.
- **Unknown key** — a typo (`"debugLo"` → `"debugLog"`) or a legacy top-level policy key (`defaultPolicy`, `tools`, `bash`, …) that belongs under `permission` (see `legacy-to-flat.md`).
- **Invalid permission action** — an action must be `"allow"`, `"deny"`, or `"ask"` (or a `{ "action": "deny", "reason": "…" }` object).

## Editor support

Add the hosted schema to your config for autocomplete and inline validation, so these problems surface as you type:

```json
"$schema": "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json"
```
