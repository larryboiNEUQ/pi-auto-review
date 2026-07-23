# 01 — Stop bundling host Pi APIs into the Git install

**What to build:** After `pi install` of this Git package, the checkout no longer carries a second copy of the Pi host runtime (pi-ai / pi-coding-agent / pi-tui and their LLM SDK trees). The extension still loads under a normal Pi host that already provides those APIs. Operators can measure a much smaller on-disk install and a faster cold start on Windows.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Root package declares host Pi packages as peers (or dev-only for local smoke), not production dependencies
- [x] Fresh `npm install --omit=dev` (the Pi Git install path) does not materialize the nested `@earendil-works/pi-*` + LLM SDK tree
- [x] Bundle contract / Git smoke still proves the single composition entry loads under a real Pi host
- [x] Before/after numbers recorded: install size and `PI_TIMING=1` extension import cost

### Measured (macOS arm64, 2026-07-23)

| Metric | Before | After (Pi path: `npm install --omit=dev`) |
|---|---|---|
| Install tree | ~328MB / ~35,549 files | ~40MB total / ~31MB node_modules / ~790 files |
| Host `@earendil-works/pi-*` in checkout | present (~171MB) | absent |
| Warm `PI_TIMING` module import | ~108–119ms | ~116–119ms (unchanged; jiti still transpiles TS) |
| Warm factory | ~88–96ms | ~79–91ms |

Windows cold start should benefit mainly from the file-count drop (Defender / NTFS); further import latency is ticket 02 (precompile).
