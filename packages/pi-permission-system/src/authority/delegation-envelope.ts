/**
 * The bounded-delegation enforcement checkpoint (ADR 0007 §5).
 *
 * By default, the chain owner caps a registered link's `allow` on the sensitive
 * `path` surface to `defer`, letting the `ask` fall through to the terminal. A
 * link may explicitly register with `honor-reviewer` to opt out of that path cap.
 * The checkpoint always preserves the fail-safe cap when no surface can be
 * determined and never turns a `defer`/`deny` into an `allow`.
 *
 * ## Local fork note (plan B)
 *
 * The upstream permission-system checkpoint excludes both `path` and
 * `external_directory`. This local fork permits reviewed `external_directory` asks
 * and makes its remaining `path` cap configurable. This is a local product rule,
 * not a Codex feature or OS sandbox.
 */

import type { Authorizer, PathEnvelopeMode } from "./authorizer";
import type { PromptPermissionDetails } from "./permission-prompter";

/**
 * Surfaces capped under the default `cap-allow` registration mode.
 * Local fork (plan B): path only — external_directory allow is permitted.
 */
export const DELEGATION_EXCLUDED_SURFACES: ReadonlySet<string> = new Set([
  "path",
]);

/**
 * Wrap a link's `authorize` with the configured path-envelope mode. `cap-allow`
 * downgrades a `path` allow to `defer`; `honor-reviewer` preserves it. An
 * undetermined surface remains capped fail-safe in either mode. Other verdicts
 * and surfaces pass through unchanged; `details` and `query` are forwarded as-is.
 */
export function encloseInDelegationEnvelope(
  authorize: Authorizer["authorize"],
  mode: PathEnvelopeMode = "cap-allow",
): Authorizer["authorize"] {
  return async (details, query) => {
    const verdict = await authorize(details, query);
    if (verdict.kind === "allow" && isExcludedSurface(details, mode)) {
      return { kind: "defer" };
    }
    return verdict;
  };
}

/**
 * Whether the ask's authoritative surface remains excluded under `mode`. Only
 * gate-computed `accessIntent.surface` may grant delegated authority; the display
 * surface is not a policy fact. Missing intent stays excluded in both modes (more
 * prompting, never less — ADR 0007 invariant 2).
 */
function isExcludedSurface(
  details: PromptPermissionDetails,
  mode: PathEnvelopeMode,
): boolean {
  const surface = details.accessIntent?.surface;
  return (
    surface === undefined ||
    (mode === "cap-allow" && DELEGATION_EXCLUDED_SURFACES.has(surface))
  );
}
