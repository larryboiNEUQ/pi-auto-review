# 02: Publish the v2.1.0 release

**What to build:** Publish the verified v2.1.0 product as a new immutable release that clearly describes the improvements since v2.0.0. Preserve the existing v2.0.0 tag and ensure the new release points to the exact reviewed commit containing synchronized version metadata and the latest bundled behavior.

**Blocked by:** 01/Synchronize the v2.1.0 release versions.

**Status:** done

- [x] The release commit contains the completed and verified v2.1.0 version synchronization from ticket 01.
- [x] A new annotated `v2.1.0` tag points to the exact intended release commit.
- [x] The existing `v2.0.0` tag is not moved, rewritten, or deleted.
- [x] Release notes summarize the exact-action review window improvement, the release differential coverage, and compatibility with the v2 line.
- [x] The release notes identify pi-permission-system as the unchanged `20.9.1-larry.b1` fork.
- [x] The repository's release-differential verification succeeds for the intended release tags before publication is considered complete.
- [x] The tag and GitHub Release are published only after all required checks pass.

### Verification

- Release commit: `96fb23e85813ca15cb2a19d4a13c12af439ebaa6`.
- Git bundle smoke passed on macOS arm64 and Windows x64: https://github.com/larryboiNEUQ/pi-auto-review/actions/runs/33298103325
- Local and repository release differentials passed for `v1.0.0 → v2.1.0`: https://github.com/larryboiNEUQ/pi-auto-review/actions/runs/33298540245
- Annotated tag `v2.1.0` peels to the release commit; `v2.0.0` still peels to `b1819950027665d87e690e9a82560d5213967799`.
- GitHub Release: https://github.com/larryboiNEUQ/pi-auto-review/releases/tag/v2.1.0
- Spec review found no release-spec gaps. Standards review noted the pre-existing `323a825` commit combined related Issues #21–#23, contrary to the repository's issue-by-issue workflow; no release artifact change can retroactively correct that historical sequencing.
