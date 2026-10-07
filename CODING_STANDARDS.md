# Coding standards

Use these rules when changing or reviewing this bundle.

## Permission boundaries

- Preserve the permission system as the deterministic owner of `allow` / `ask` / `deny`. Delegate only eligible `ask`s to safe-allow; a reviewer result must not override a recorded deny. Preserve fail-closed handling when review evidence, authority, or audit is unavailable.
- For rules, gates, or delegation changes, verify evaluation and authority seams against the [architecture](packages/pi-permission-system/docs/architecture/architecture.md). Check policy precedence in the [configuration reference](packages/pi-permission-system/docs/configuration.md). Apply the overrides in [FORK.md](packages/pi-permission-system/FORK.md) before upstream defaults or historical plans.
- Keep this an approval layer, not an OS-sandbox claim. Test the affected boundary when editing reviewer evidence, redaction, probes, or human fallback.

## Changes and verification

- Add or update focused regression tests for changed routing, denial, escalation, or reviewer outcomes. Run the relevant workspace checks/tests via its [package scripts](packages/pi-permission-system/package.json) or [reviewer scripts](packages/pi-permission-safe-allow/package.json); use the [root scripts](package.json) for bundle-level verification.
- Source changes that affect the shipped entry require rebuilding and committing the generated root `index.js`. Check the single-entry, host-peer, and Git-install contract with the [bundle verification script](scripts/verify-git-bundle.mjs) through the root package scripts. The [build script](scripts/build-extension.mjs) owns generation and stale-bundle checking; edit the TypeScript sources rather than patching generated output.
