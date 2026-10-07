# Coding standards

Use these rules when changing or reviewing this bundle. The [root README](README.md) defines its install and composition contract; the [root scripts](package.json) own build, check, test, and smoke commands.

## Permission boundaries

- Preserve the permission system as the deterministic owner of `allow` / `ask` / `deny`. Delegate only eligible `ask`s to safe-allow; a reviewer result must not override a recorded deny. Preserve fail-closed handling when review evidence, authority, or audit is unavailable. For the reviewer’s precise outcome and failure semantics, read the [safe-allow README](packages/pi-permission-safe-allow/README.md).
- When changing rules, gates, or delegation, check the [current architecture](packages/pi-permission-system/docs/architecture/architecture.md) for the evaluation/authority seams and the [configuration reference](packages/pi-permission-system/docs/configuration.md) for policy precedence. For the bundled fork’s intentional differences from upstream defaults, read [FORK.md](packages/pi-permission-system/FORK.md); do not infer bundle behavior from an upstream example or historical plan.
- Keep this an approval layer, not an OS-sandbox claim. When editing reviewer evidence, redaction, probes, or human fallback, use the [safe-allow README](packages/pi-permission-safe-allow/README.md) as the behavior contract and test the affected boundary.

## Changes and verification

- Add or update focused regression tests for changed routing, denial, escalation, or reviewer outcomes. Run the relevant workspace checks/tests via its [package scripts](packages/pi-permission-system/package.json) or [reviewer scripts](packages/pi-permission-safe-allow/package.json); use the [root scripts](package.json) for bundle-level verification.
- Source changes that affect the shipped entry require rebuilding and committing the generated root `index.js`. Check the single-entry, host-peer, and Git-install contract with the [bundle verification script](scripts/verify-git-bundle.mjs) through the root package scripts. The [build script](scripts/build-extension.mjs) owns generation and stale-bundle checking; edit the TypeScript sources rather than patching generated output.
