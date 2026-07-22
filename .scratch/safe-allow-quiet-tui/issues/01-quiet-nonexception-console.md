# 01 — Quiet non-exceptional safe-allow console output

**What to build:** Keep JSONL audit complete, but stop printing routine safe-allow lifecycle events to the interactive console. Cancel registration retries after success. Surface only exceptional events by default.

**Type:** task  
**Status:** completed  
**Blocked by:** —

## Requirements

- [x] `logSafeAllow` always appends redacted JSONL.
- [x] Console surface defaults to exceptional events only:
  - `register.fail`
  - `config.issue`
  - `denial.circuit_breaker`
  - `review.failure`
- [x] `PI_SAFE_ALLOW_VERBOSE=1` surfaces every event.
- [x] Successful `registerAuthorizer` clears pending retry timers and does not schedule more.
- [x] At most one retry chain is scheduled per session attempt (no stacking of `session_start` + `permissions_ready` finals).
- [x] Intermediate `permissions_service_missing` remains file-only; the final retry escalates to `register.fail` (console-visible).
- [x] `/approve` command registration is untouched.
- [x] Tests:
  - console quiet for routine events
  - console loud for exceptional events
  - verbose env override
  - successful session_start registers once and does not re-register after timer advance

## Windows principle analysis

### What this change touches

| Layer | Touched? | Notes |
|---|---|---|
| `console.warn` filtering | Yes | Pure event-name gate before stderr write |
| JSONL `appendFileSync` | No behavior change | Same path join via `homedir()` + `path.join` |
| `setTimeout` / `clearTimeout` retries | Yes | Fewer timers after success; same delays |
| `registerAuthorizer` / dispose | No semantics change | Still one successful registration per session |
| Reviewer dossier / model / verdicts | No | Untouched |
| Path/shell/MCP/Windows trap transport | No | Outside this package surface |
| `/approve` command | No | Still `registerCommand("approve", …)` |

### Why Windows should not see different functional impact

1. **No OS APIs.** The diff is TypeScript on Node timers + stderr + local file append. Windows and macOS share the same Node semantics for these primitives.
2. **No path or shell contract change.** Quiet logging does not rewrite `cwd`, does not spawn shells, and does not alter how dossier fields are normalized for Windows paths or PowerShell/cmd representations (those live elsewhere and are unchanged).
3. **Authorizer chain unchanged.** Registration still publishes the same `safe-allow` link into the permission-system chain. Allow/deny/defer outcomes, fail-closed timeouts, and circuit breakers are identical; only whether a diagnostic line hits the TUI changes.
4. **Retry cancellation is platform-neutral and beneficial.** Cancelling timers after success reduces event-loop noise equally on Windows; it cannot make registration “half-succeed” because success already set `dispose` before `clearRetries()`.
5. **Failure visibility preserved.** If registration truly fails (missing service through final retry, missing API, throw), Windows operators still get a console `register.fail` — same as macOS.
6. **Audit remains the cross-platform source of truth.** Health checks on either OS should read `safe-allow.jsonl` (or set `PI_SAFE_ALLOW_VERBOSE=1`), not the absence of green TUI spam.

### Residual non-functional notes (not regressions)

- Operators who used console spam as a “plugin loaded” heartbeat will need JSONL or verbose mode — intentional product decision, same on every OS.
- Pi’s TUI rendering of stderr may differ cosmetically by terminal (Windows Terminal vs macOS Terminal), but this change *reduces* stderr volume, so it cannot introduce new Windows-only stderr storms.
- GitHub Actions Windows smoke for the broader delegated-approval matrix remains a separate, previously deferred receipt; this ticket does not re-open that CI billing gap.

### Verdict

**No expected Windows-specific functional regression.** The change is presentation + timer hygiene on a shared Node runtime path.

## Implementation notes

- `src/log.ts` — `CONSOLE_EVENTS` allow-list + verbose env gate.
- `src/extension.ts` — `tryRegister` returns success boolean; `scheduleRetries` only when needed; `final` retry escalates missing service; `clearRetries` on success.
- Tests: `test/log.test.ts`, extended `test/extension.test.ts`.

## Answer / Completion evidence — 2026-07-22

- Behavior matches wayfinder decision: non-exception full quiet; prototype retained as the implementation.
- Upstream: private GitHub `larryboiNEUQ/pi-permission-local-fork`.
- Local Pi currently loads the package via path install from this checkout; push updates the private remote for `pi install`/`pi update` consumers.
