# 01 — Make the fork a Git-installable Pi bundle

**What to build:** Make one GitHub repository URL install and update the complete permission-system plus safe-allow bundle, including runtime dependencies, deterministic extension order, and the internal fork relationship, without manual local-path installation or dependency symlinks.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] A clean `pi install` from the repository URL succeeds in an isolated Pi agent directory and records one Git source.
- [x] Pi discovers exactly the permission-system and safe-allow extensions, in that order, and loads both without extension errors.
- [x] All runtime dependencies resolve from the installed Git checkout, and safe-allow resolves the matching workspace permission-system fork rather than an unrelated registry copy.
- [x] The installation requires no manual symlink, junction, second package install, or post-clone dependency command.
- [x] Updating the Git source preserves dependency resolution, extension discovery, load order, and clean startup.
- [x] The real install/load smoke passes on macOS ARM64 and has an equivalent Windows verification path.
- [x] Documentation gives the one-command Git installation and update workflow and does not present `pi list` alone as proof of successful loading.

## Completion Evidence

- Implementation commits: `879b997` (`feat: make permission fork Git-installable`) and `64b05f8` (`fix(ci): make bundle smoke portable`).
- Local verification on macOS ARM64 (2026-07-22): `npm run check`; `npm test` (126 test files, 2534 tests); `npm run smoke:git` (isolated clean install plus changed-HEAD update); and `git diff --check` all passed.
- The Windows x64 equivalent path is defined by `.github/workflows/git-bundle-smoke.yml` and uses the same real-install smoke with platform-specific command handling. Its execution is deferred under the user's local-first acceptance direction.
- GitHub Actions run `29848065896` did not execute either platform job because of account billing/spending-limit settings (`steps: []`, no runner assigned). CI is not used as Ticket 01 completion evidence.
- Final specification review against the adjusted acceptance direction: 0 findings.
