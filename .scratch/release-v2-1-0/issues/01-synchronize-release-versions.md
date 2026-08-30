# 01: Synchronize the v2.1.0 release versions

**What to build:** Prepare the bundled pi-auto-review product for the v2.1.0 release by assigning version 2.1.0 to both pi-auto-review and its first-party pi-permission-safe-allow package, while preserving the independently versioned pi-permission-system fork. Keep generated dependency metadata consistent and verify that the bundled extension still builds and passes its test suite.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] pi-auto-review reports version `2.1.0`.
- [x] pi-permission-safe-allow reports version `2.1.0` under the shared release train.
- [x] pi-permission-system remains at fork version `20.9.1-larry.b1`, including all dependency references to that fork version.
- [x] Dependency lock metadata agrees with the package manifests and introduces no unrelated dependency updates.
- [x] The committed extension bundle is rebuilt only if the version change affects its generated output.
- [x] Build, bundle verification, type checks, and automated tests pass.
- [x] The change does not create, move, or push a Git tag.

### Verification

- `npm install --package-lock-only --ignore-scripts --offline` kept dependency metadata stable.
- `npm run build` produced a byte-identical `index.js` bundle.
- `npm run check` and `npm test` passed against the tracked release tree.
- Two-axis code review found no standards or spec findings.
- No Git tag points at the release-preparation commit.
