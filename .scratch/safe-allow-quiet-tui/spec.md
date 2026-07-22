# Safe-Allow Quiet TUI Logging

**Status:** completed  
**Package:** `packages/pi-permission-safe-allow`  
**Upstream:** `https://github.com/larryboiNEUQ/pi-permission-local-fork` (private)

## Problem

On session start, `pi-permission-safe-allow` retries authorizer registration against load-order races (`session_start` vs `permissions:ready`). Each attempt called `logSafeAllow`, which always `console.warn`’d into the interactive Pi TUI.

That produced a wall of green lines such as:

```text
[pi-permission-safe-allow] register.skip { source: 'session_start+50ms', reason: 'already_registered' }
[pi-permission-safe-allow] session_shutdown {}
```

The noise no longer blocked the input box, but it still polluted the transcript. Operators want a quiet default: **non-exceptional lifecycle traffic stays off the console**.

## Destination (decided)

Quiet startup UX for safe-allow:

1. **Non-exceptional events are fully silent on the console** (no `register.ok`, no `register.skip`, no `session_start` / `session_shutdown` / `extension_loaded` / `permissions_ready`).
2. **Exceptional events still surface** via `console.warn`:
   - `register.fail`
   - `config.issue`
   - `denial.circuit_breaker`
   - `review.failure`
3. **JSONL audit remains always-on** at  
   `~/.pi/agent/extensions/pi-permission-safe-allow/logs/safe-allow.jsonl`
4. **Escape hatch:** `PI_SAFE_ALLOW_VERBOSE=1` restores full console surface for debugging.
5. **Registration retries** cancel once registration succeeds so the process does not keep firing expected `already_registered` skips.
6. **Slash command `/approve` is unchanged** and remains registered.

## Non-goals

- Changing reviewer allow/deny semantics, dossier shape, or circuit-breaker thresholds.
- Changing permission-system policy.
- Adding a status-line widget or one-shot “loaded” toast (explicitly rejected: full quiet unless exceptional).
- OS sandbox or platform-specific shell behavior.

## Platform note (Windows)

This change is presentation and timer-scheduling only. It does not alter path normalization, shell dossier construction, process spawning, or authorizer verdicts. Behavior is expected to be identical on macOS and Windows Node runtimes; see issue `01` for the principle analysis.

## Acceptance

- [x] Starting a Pi session with safe-allow loaded shows no routine `[pi-permission-safe-allow]` console lines.
- [x] JSONL still records `extension_loaded`, `session_start`, `register.ok` (or `register.fail` if broken).
- [x] After successful register, no further retry timers re-enter registration.
- [x] If the permissions service never appears through the final retry, one `register.fail` is console-visible.
- [x] Config issues, circuit breakers, and review failures still console-warn.
- [x] `/approve` remains registered.
- [x] Unit tests cover console filtering and successful-register canceling retries.
- [x] Spec/issue recorded under `.scratch/safe-allow-quiet-tui/`.
