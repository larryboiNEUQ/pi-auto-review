# Issue #54 — Pi-stored TypeSafe credential

The Jev evaluation backend now reads a literal `typesafe` API key from Pi's
`auth.json` after `TYPESAFE_API_KEY` and before Vercel Gateway. An explicit
transport override still wins. Malformed credentials and an unreadable store
return authentication failure without switching to Gateway. The picker and
audit name the selected route and key source; neither displays the key.

## Local verification (2026-09-29)

- `npm run check` passed both workspaces.
- `npm test` passed: 32 differential unit tests (one Windows-only skip),
  2,698 permission-system tests, and 462 Safe-Allow tests (13 skips). The first
  sandboxed run could not bind its loopback browser fixture; the full rerun
  with loopback permission passed.
- `npm run build` and `npm run verify:bundle` passed on macOS.
- A local Pi `auth.json` entry with mode `0600` supplied the official key.
  The synthetic `routine-bash-git-status` case completed two live Jev requests
  via `api.typesafe.ai`: one with the official route forced and one with
  automatic route selection and no environment key. The auto result identified
  official response model `jev-1.13.0`. Both were reviewed as `allow` (`low`
  risk, `low` authorization, `narrow` scope) in 2,390 and 2,355 ms.
  The corpus action was not executed. This proves credential resolution and
  endpoint connectivity for one request; it is not an approval-quality result.
- No key was written to this repository or the saved result artifact.

CI evidence for the committed head is recorded in Issue #54 after push.
