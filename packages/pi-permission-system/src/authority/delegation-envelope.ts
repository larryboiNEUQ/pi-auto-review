/**
 * The bounded-delegation enforcement checkpoint (ADR 0007 §5).
 *
 * The chain owner caps every registered link's verdict so a buggy or over-eager
 * external judge can never exceed the operator's policy: a link's `allow` on an
 * excluded surface is downgraded to `defer`, letting the `ask` fall through to
 * the terminal (a prompt) instead. The checkpoint only ever *tightens* a
 * verdict — it never turns a `defer`/`deny` into an `allow`.
 *
 * ## Local fork note (plan B)
 *
 * Upstream excludes both `path` and `external_directory`.
 * This local fork keeps only `path` excluded so an allow-capable authorizer
 * may grant outside-CWD access after review, while still preventing judges from
 * auto-allowing sensitive file patterns (`.env`, keys, etc.).
 */

import type { Authorizer } from "./authorizer";
import type { PromptPermissionDetails } from "./permission-prompter";

/**
 * Surfaces on which a link may never grant an `allow`.
 * Local fork (plan B): path only — external_directory allow is permitted.
 */
export const DELEGATION_EXCLUDED_SURFACES: ReadonlySet<string> = new Set([
  "path",
]);

/**
 * Wrap a link's `authorize` so an `allow` on an excluded surface is capped to
 * `defer`. All other verdicts, and `allow`s on non-excluded surfaces, pass
 * through unchanged. `details` and the injected `query` are forwarded as-is.
 */
export function encloseInDelegationEnvelope(
  authorize: Authorizer["authorize"],
): Authorizer["authorize"] {
  return async (details, query) => {
    const verdict = await authorize(details, query);
    if (verdict.kind === "allow" && isExcludedSurface(details)) {
      return { kind: "defer" };
    }
    return verdict;
  };
}

/**
 * Whether the ask's surface is excluded from link grants. Reads the
 * gate-authoritative `accessIntent.surface`, falling back to the display
 * `surface`. Fail-safe: an ask whose surface cannot be determined is treated as
 * excluded (more prompting, never less — ADR 0007 invariant 2).
 */
function isExcludedSurface(details: PromptPermissionDetails): boolean {
  const surface = details.accessIntent?.surface ?? details.surface ?? undefined;
  return surface === undefined || DELEGATION_EXCLUDED_SURFACES.has(surface);
}
