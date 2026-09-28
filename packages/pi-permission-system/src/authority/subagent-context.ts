import { SUBAGENT_ENV_HINT_KEYS } from "#src/authority/permission-forwarding";
import type { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import type { PathFlavor } from "#src/path/path-flavor";

const EXPERIMENTAL_NESTED_FORWARDING_ENV =
  "PI_PERMISSION_EXPERIMENTAL_NESTED_FORWARDING";

/**
 * Narrow context for subagent detection — the only session-manager readers
 * {@link isSubagentExecutionContext} and {@link isRegisteredSubagentChild}
 * consume. A full `ExtensionContext` satisfies this structurally.
 */
export interface SubagentDetectionContext {
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
    /** Present when this session is persisted. */
    getSessionFile?(): string | undefined;
    /** Present in current Pi; optional for older SDK-compatible contexts. */
    getSessionName?(): string | undefined;
    /** Persisted session header, including `parentSession` when available. */
    getHeader?(): { parentSession?: unknown } | null;
  };
}

export function normalizeFilesystemPath(
  pathValue: string,
  flavor: PathFlavor,
): string {
  return flavor.fold(flavor.impl.normalize(pathValue));
}

/**
 * Return `true` when `ctx` belongs to an in-process subagent child registered
 * in `registry` by its session id.
 *
 * This is the only signal that identifies an **in-process** child (one sharing
 * the parent's `globalThis`); env-hint and filesystem heuristics identify
 * **process-based** subagents instead. The composition root uses this to decide
 * whether the instance owns the process-global service slot — a registered
 * child must not publish over its parent.
 */
export function isRegisteredSubagentChild(
  ctx: SubagentDetectionContext,
  registry: SubagentSessionRegistry,
  experimentalNestedForwarding = true,
): boolean {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) {
      return false;
    }
    const info = registry.get(sessionId);
    if (info?.experimentalNestedForwarding && !experimentalNestedForwarding) {
      return false;
    }
    if (info?.tintinAgentId && !registry.hasActiveTintinRun(info.tintinAgentId)) {
      registry.unregister(sessionId);
      return false;
    }
    return info !== undefined;
  } catch {
    // getSessionId() unavailable — treat as not-a-registered-child.
    return false;
  }
}

export function isSubagentExecutionContext(
  ctx: SubagentDetectionContext,
  subagentSessionsDir: string,
  flavor: PathFlavor,
  registry?: SubagentSessionRegistry,
  experimentalNestedForwarding = false,
): boolean {
  const experimentalNestedForwardingEnabled =
    experimentalNestedForwarding ||
    process.env[EXPERIMENTAL_NESTED_FORWARDING_ENV] === "1";
  // 1. Explicit registry — in-process subagent extensions register by child
  //    session id before bindExtensions(); checked first so it takes priority
  //    over heuristics. Each concurrent sibling has a unique session id, so
  //    one sibling's disposed event cannot affect another's registration.
  if (
    registry &&
    isRegisteredSubagentChild(ctx, registry, experimentalNestedForwardingEnabled)
  ) {
    return true;
  }

  // tintinweb's in-process runner emits `subagents:started` on the parent
  // event bus, then names the child `${agentName}#${agentId.slice(0, 8)}` before
  // binding extensions. The child instance matches that live run against its
  // optional persisted `parentSession` header here, before terminal-authorizer
  // selection, and caches the result by this child's own session ID.
  if (registry) {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionName = ctx.sessionManager.getSessionName?.();
      const parentSession = ctx.sessionManager.getHeader?.()?.parentSession;
      const hasParentHeader =
        parentSession !== undefined && parentSession !== null;
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      const info =
        hasParentHeader && typeof parentSession !== "string"
          ? undefined
          : registry.findTintinParent({
              sessionName,
              parentSessionFile:
                typeof parentSession === "string" ? parentSession : undefined,
            });
      if (sessionId && info) {
        registry.register(sessionId, { ...info, sessionFile });
        return true;
      }
      // EXPERIMENTAL: tintinweb suppresses nested run lifecycle events. When
      // explicitly enabled, let a headerless tintin-shaped child borrow the
      // sole active top-level run's root UI target. This is not reliable
      // lineage: an unrelated concurrent nested child could be misrouted.
      if (
        sessionId &&
        !hasParentHeader &&
        registry.hasTintinSessionName(sessionName) &&
        experimentalNestedForwardingEnabled
      ) {
        const experimentalInfo = registry.findUniqueActiveTintinParent();
        if (experimentalInfo) {
          registry.register(sessionId, {
            ...experimentalInfo,
            experimentalNestedForwarding: true,
          });
          return true;
        }
      }
      // A tintinweb-shaped name without a matching unique live run
      // is explicitly untrusted; do not let unrelated env/path heuristics
      // turn it into a forwardable subagent.
      if (registry.hasTintinSessionName(sessionName)) return false;
    } catch {
      // Missing or ambiguous lineage is untrusted and fails closed.
    }
  }

  const sessionDir = ctx.sessionManager.getSessionDir();

  // 2. Env vars — process-based subagent extensions (nicobailon/pi-subagents,
  //    HazAT/pi-interactive-subagents, pi-agent-router, etc.).
  for (const key of SUBAGENT_ENV_HINT_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }

  // 3. Filesystem path — fallback heuristic for extensions that store sessions
  //    under a known subagent root directory.
  if (!sessionDir) {
    return false;
  }

  const normalizedSessionDir = normalizeFilesystemPath(sessionDir, flavor);
  const normalizedSubagentRoot = normalizeFilesystemPath(
    subagentSessionsDir,
    flavor,
  );
  return flavor.isWithin(normalizedSessionDir, normalizedSubagentRoot);
}
