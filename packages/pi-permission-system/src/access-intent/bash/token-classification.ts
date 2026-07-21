/**
 * Pure, synchronous token-classification helpers for bash path extraction.
 *
 * Exports three classifiers consumed by `bash-path-resolver.ts`:
 *   - `classifyTokenAsPathCandidate` — strict gate for the external-directory guard.
 *   - `classifyTokenAsRuleCandidate` — broader gate for cross-cutting `path` rules.
 *   - `classifyPromotedRuleCandidate` — rule-driven promotion of a bare filename
 *     (e.g. `id_rsa`) that `classifyTokenAsRuleCandidate` rejects for shape, but
 *     which matches an active, specific (non-`*`) `path` deny/ask rule (#509).
 *
 * All three classifiers share the private `rejectNonPathToken` predicate that
 * captures the six rejection cases common to them (the production clone this
 * module was extracted to eliminate).
 *
 * Both `classifyTokenAsPathCandidate` and `classifyTokenAsRuleCandidate` recognize
 * Windows drive-letter absolute paths (`C:/…`, `C:\…`) unconditionally on all
 * platforms. On POSIX the token resolves as a real in-CWD relative path and is
 * gated by the `path` surface; on Windows the `PathNormalizer` routes it through
 * the absolute-path branch. Shape recognition is platform-independent string
 * matching; the platform-sensitive absoluteness decision belongs to `PathNormalizer`.
 *
 * `classifyTokenAsRuleCandidate` takes the resolved {@link PathFlavor}: a
 * backslash-relative token (`dir\file`, no leading `.`, no `/`, no `..`, not a
 * drive-letter absolute) is accepted as path-shaped only under the win32 flavor,
 * whose `hasPathSeparator` counts `\` as a separator (#520). This is the one
 * genuinely platform-sensitive shape rule the classifier owns — on POSIX `\` is
 * a legal filename character — and the flavor owns the bit, so the classifier
 * never reads `process.platform` itself.
 */
import type { PathFlavor } from "#src/path/path-flavor";
import type { PathRuleTokenMatcher } from "#src/types";

// ── Public classifiers ─────────────────────────────────────────────────────

/**
 * Strict path-candidate classifier for the external-directory guard.
 *
 * Accepts tokens that unambiguously look like filesystem paths:
 * - Absolute paths (starting with `/`)
 * - Home-relative paths (starting with `~/`)
 * - Parent-traversal paths (containing `..`)
 * - Windows drive-letter absolute paths (`C:/…` or `C:\…`)
 *
 * Returns the raw token string if it qualifies, or `null` to skip.
 */
export function classifyTokenAsPathCandidate(token: string): string | null {
  if (rejectNonPathToken(token)) return null;

  if (token.startsWith("/")) return token;
  if (token.startsWith("~/")) return token;
  if (token.includes("..")) return token;
  if (WINDOWS_DRIVE_PATH_PATTERN.test(token)) return token;

  return null;
}

/**
 * Broader token classifier for cross-cutting `path` permission rules.
 *
 * Accepts the same shapes as `classifyTokenAsPathCandidate`, plus:
 * - Dot-files and `./`-relative paths (starting with `.`)
 * - Any token carrying a path separator under `flavor` (`src/foo.ts`, and on
 *   win32 the backslash-relative `dir\file`, #520) — `flavor.hasPathSeparator`
 *   owns the platform bit (POSIX: `/` only; win32: `/` or `\`), so this
 *   classifier never reads `process.platform`.
 * - Windows drive-letter absolute paths (`C:/…` or `C:\…`)
 *
 * The `~/foo` case is covered by `hasPathSeparator` — no separate `~/` branch needed.
 * The forward-slash drive form (`C:/…`) is also caught by `hasPathSeparator`, but the
 * explicit `WINDOWS_DRIVE_PATH_PATTERN` branch makes both separator forms first-class
 * and order-independent, and covers the backslash-only form (`D:\…`) which the POSIX
 * flavor's `hasPathSeparator` cannot reach.
 *
 * Does NOT require the strict "must start with `/` or `~/` or contain `..`"
 * gate that the external-directory classifier uses.
 *
 * Returns the raw token string if it qualifies, or `null` to skip.
 */
export function classifyTokenAsRuleCandidate(
  token: string,
  flavor: PathFlavor,
): string | null {
  if (rejectNonPathToken(token)) return null;

  if (token.startsWith(".")) return token;
  if (flavor.hasPathSeparator(token)) return token; // ~/ paths, relative paths with /, and win32 dir\file
  if (token.includes("..")) return token; // bare ".." (no slash)
  if (WINDOWS_DRIVE_PATH_PATTERN.test(token)) return token; // backslash-only drive form

  return null;
}

/**
 * Rule-driven promotion classifier for bare filenames (#509).
 *
 * A bare token (`id_rsa`) has none of the shapes `classifyTokenAsRuleCandidate`
 * accepts, so it is dropped before rule evaluation by default — most bash
 * argument tokens are not file paths (subcommands, branch names, search
 * patterns). This classifier promotes a bare token into the rule-candidate
 * surface only when the caller-supplied `isPromotable` predicate says it
 * matches an active, specific `path` deny/ask rule, closing the bypass without
 * treating every bare argument as a path.
 *
 * Still runs the shared `rejectNonPathToken` prelude first, so a flag,
 * env-assignment, URL, `@scope` token, or regex-shaped token is never
 * promoted even if it happens to match a configured pattern.
 *
 * Returns the raw token string if it qualifies, or `null` to skip.
 */
export function classifyPromotedRuleCandidate(
  token: string,
  isPromotable: PathRuleTokenMatcher,
): string | null {
  if (rejectNonPathToken(token)) return null;
  return isPromotable(token) ? token : null;
}

// ── Private rejection predicate ────────────────────────────────────────────

/**
 * Windows drive-letter absolute path: a single ASCII letter, a colon, then a
 * separator (`/` or `\`). Matches `C:/…` and `C:\…` but not drive-relative
 * `C:foo` (no separator) or multi-letter schemes (`https:`, `mailto:`).
 * Single-letter schemes with `//` (e.g. `c://x`) are already rejected by
 * `URL_PATTERN` before this pattern is tested.
 */
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:[/\\]/;

/**
 * URL pattern to skip tokens that look like URLs rather than paths.
 */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Regex metacharacter sequences that are never found in real filesystem paths.
 * If a token contains any of these, it is almost certainly a regex pattern
 * (e.g. a grep argument) rather than a path.
 */
const REGEX_METACHAR_PATTERN = /\.\*|\.\+|\\\||\\\(|\\\)|\[.*?\]|\^\//;

/**
 * Shared rejection prelude: returns `true` when a token can never be a
 * filesystem path, regardless of which classifier is asking.
 *
 * Rejects: empty tokens, flags (leading `-`), env assignments (`FOO=/bar`),
 * URLs, `@scope/package` patterns, and regex metacharacter sequences.
 *
 * A bare `/` (or `//`, `///`) is NOT rejected: it denotes the filesystem root,
 * a deliberate external-directory access (`find /`, `ls /`), so it must reach
 * the path surfaces like any other absolute token (#583).
 */
function rejectNonPathToken(token: string): boolean {
  if (!token) return true;
  if (token.startsWith("-")) return true;

  // Env assignment: = appears before any /  (FOO=/bar is an assignment,
  // /foo=bar is not because the slash comes first).
  const eqIndex = token.indexOf("=");
  const slashIndex = token.indexOf("/");
  if (eqIndex !== -1 && (slashIndex === -1 || eqIndex < slashIndex))
    return true;

  if (URL_PATTERN.test(token)) return true;

  // @scope/package patterns (npm scoped packages) — but @/ is allowed through
  // since it looks like an absolute-rooted path, not an npm scope.
  if (token.startsWith("@") && !token.startsWith("@/")) return true;

  if (REGEX_METACHAR_PATTERN.test(token)) return true;

  return false;
}
