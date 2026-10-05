# 03 — Defer reviewer-only imports until an ask is reviewed

**What to build:** Eligible-ask review still works, but opening a Pi session no longer pays for reviewer-only module work up front. Factory registration stays light; model completion wiring happens when the first review runs.

**Blocked by:** 01 — Stop bundling host Pi APIs into the Git install

**Status:** ready-for-agent (deferred — modest expected gain)

- [ ] Session start / factory path does not eagerly pull reviewer completion wiring
- [ ] First eligible ask still receives a delegated review decision
- [ ] PI_TIMING factory cost does not regress vs ticket 01 baseline

### Why deferred (2026-07-24)

After tickets 01–02, remaining startup cost is mostly **factory ~80–90ms** (permission-system object graph + registration), not module import.

- Warm **module import** is already ~36–46ms (precompiled entry).
- Host Pi already loads `@earendil-works/pi-ai` for itself; aliasing means lazy `complete` import is unlikely to reclaim large chunks of process startup.
- Expected win: small single-digit to low tens of ms on factory at best — not another multi-x leap like 01 (install size) or 02 (import).

Keep open for a later polish pass; do not block shipping 01+02.
