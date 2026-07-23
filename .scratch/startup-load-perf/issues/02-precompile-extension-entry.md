# 02 — Ship a precompiled extension entry for faster jiti load

**What to build:** Pi can load a compiled JS composition entry instead of jiti-transpiling the full TypeScript graph (~100+ source files) on every process start. Startup `module import` time drops further after ticket 01’s install-size win, especially on cold Windows disks.

**Blocked by:** 01 — Stop bundling host Pi APIs into the Git install

**Status:** done

- [x] Extension discovery points at a built JS entry that composes both factories
- [x] Fresh process load (PI_TIMING module import) is measurably faster than TypeScript-only entry
- [x] Smoke/contract still proves load order and zero load errors

### Measured (macOS arm64, lean `npm install --omit=dev` tree, 2026-07-23)

| Metric | `index.ts` (jiti) | `index.js` (precompiled) |
|---|---|---|
| Cold module import | ~495–531ms | ~204–212ms |
| Warm module import | ~116–122ms | **~36–46ms** |
| Factory | ~83–94ms | ~82–88ms |
| Warm extension TOTAL | ~203–215ms | **~121–128ms** |

Artifact size: ~136KB minified ESM (`npm run build`).
