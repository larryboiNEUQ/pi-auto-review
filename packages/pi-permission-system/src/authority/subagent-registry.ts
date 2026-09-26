/**
 * subagent-registry.ts — In-process subagent session registry.
 *
 * In-process subagent extensions can register each child session here before
 * calling `bindExtensions()`. For tintinweb's existing top-level lifecycle,
 * the permission system records active agent IDs against their parent; the
 * child associates itself during startup using its session-name ID prefix
 * and, when available, its parent-session header.
 *
 * The registry is keyed by the child's **session id**, which is unique per
 * child and available to both producer (via `sessionManager.getSessionId()`
 * after `newSession()` in `create-subagent-session.ts`) and consumer (via
 * `ctx.sessionManager.getSessionId()`). Two concurrent siblings of the same
 * parent therefore occupy distinct keys, so one sibling's `disposed` event
 * cannot evict the entry the others depend on.
 *
 * The single registry instance is stored on `globalThis` (via `Symbol.for()`)
 * so that the parent's permission-system instance (which registers children
 * on the parent's event bus) and each child's separate jiti instance (which
 * reads the registry to detect itself and resolve its forwarding target) share
 * one store across per-session event buses. See `getSubagentSessionRegistry()`.
 *
 * When a future code path needs the child's agent name, read it from
 * `tcc.agentName` (resolved from the `<active_agent>` system-prompt tag) —
 * not from this registry.
 */

/** Process-global key for the shared registry slot. */
const SUBAGENT_SESSION_REGISTRY_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:subagent-registry",
);

/**
 * Return the process-global SubagentSessionRegistry, creating it on first call.
 *
 * Backed by `globalThis` + `Symbol.for()` so the parent's permission-system
 * instance (which registers children on the parent event bus) and each child's
 * separate jiti instance (which reads the registry to detect itself and resolve
 * its forwarding target) share one store across per-session event buses.
 *
 * A child's `session_shutdown` must not wipe parent-owned run signals. Native
 * lifecycle entries are removed by the publisher's disposed event; tintinweb
 * run signals are removed by its completed/failed event or parent shutdown.
 */
export function getSubagentSessionRegistry(): SubagentSessionRegistry {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[SUBAGENT_SESSION_REGISTRY_KEY] as
    | SubagentSessionRegistry
    | undefined;
  if (existing) {
    return existing;
  }
  const registry = new SubagentSessionRegistry();
  store[SUBAGENT_SESSION_REGISTRY_KEY] = registry;
  return registry;
}

/** Signal stored per registered in-process subagent session. */
export interface SubagentSessionInfo {
  /** Parent session ID for permission forwarding. Omit when unknown. */
  parentSessionId?: string;
  /** Present only for sessions lazily associated with a tintinweb run. */
  tintinAgentId?: string;
  /** True when association used the opt-in, unreliable nested-run fallback. */
  experimentalNestedForwarding?: boolean;
  /** This session's persisted file, used to resolve persisted descendants. */
  sessionFile?: string;
}

/** A tintinweb top-level run observed on its parent's event bus. */
export interface TintinSubagentRun extends SubagentSessionInfo {
  /** Full run id from `subagents:started`. */
  agentId: string;
  /** Persisted parent session file, used to validate a child header if present. */
  parentSessionFile?: string;
}

/**
 * Registry of active in-process subagent sessions.
 *
 * A process-global singleton — obtain it via `getSubagentSessionRegistry()`,
 * never `new` (see that accessor for why). Written exclusively by
 * `subscribeSubagentLifecycle` via the `subagents:child:session-created` /
 * `subagents:child:disposed` event subscription (ADR 0002 — the core
 * publishes, consumers observe).
 *
 * Keyed by child session id. Each concurrent child of the same parent receives
 * a unique session id from `sessionManager.newSession()`, so siblings occupy
 * distinct keys and one sibling's `disposed` cannot evict another's entry.
 */
export class SubagentSessionRegistry {
  private readonly sessions = new Map<string, SubagentSessionInfo>();
  private readonly tintinRuns = new Map<string, TintinSubagentRun[]>();

  /**
   * Register an in-process subagent session.
   *
   * If a previous entry exists for `sessionId`, it is overwritten
   * (last-write-wins; single-writer expected per key).
   */
  register(sessionId: string, info: SubagentSessionInfo): void {
    this.sessions.set(sessionId, info);
  }

  /** Remove a previously registered session. No-op if the key is absent. */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Return the registered info for `sessionId`, or `undefined` if absent. */
  get(sessionId: string): SubagentSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** Return `true` when `sessionId` has a registered entry. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Record a started tintinweb run against the active persisted parent. */
  startTintinRun(run: TintinSubagentRun): void {
    const runs = this.tintinRuns.get(run.agentId) ?? [];
    runs.push(run);
    this.tintinRuns.set(run.agentId, runs);
  }

  /** Forget a tintinweb run when it completes or fails. */
  finishTintinRun(agentId: string, parentSessionId?: string): void {
    if (!parentSessionId) {
      const parentSessionIds = new Set(
        (this.tintinRuns.get(agentId) ?? [])
          .map((run) => run.parentSessionId)
          .filter((id): id is string => Boolean(id)),
      );
      for (const parentId of parentSessionIds) {
        this.removeTintinRunsForParent(agentId, parentId);
      }
      this.tintinRuns.delete(agentId);
      return;
    }
    this.removeTintinRunsForParent(agentId, parentSessionId);
  }

  /** Whether a started tintinweb run is still active. */
  hasActiveTintinRun(agentId: string): boolean {
    return (this.tintinRuns.get(agentId)?.length ?? 0) > 0;
  }

  /** Return the sole active tintin run with a recorded UI parent, if unique. */
  findUniqueActiveTintinParent(): SubagentSessionInfo | undefined {
    const runs = [...this.tintinRuns.values()].flat();
    if (runs.length !== 1 || !runs[0]?.parentSessionId) return undefined;
    return {
      parentSessionId: runs[0].parentSessionId,
      tintinAgentId: runs[0].agentId,
    };
  }

  /** Clear runs owned by a parent session when that session shuts down. */
  clearTintinRunsForParent(parentSessionId: string): void {
    for (const agentId of this.tintinRuns.keys()) {
      this.removeTintinRunsForParent(agentId, parentSessionId);
    }
  }

  private removeTintinRunsForParent(
    agentId: string,
    parentSessionId: string,
  ): void {
    const remaining = (this.tintinRuns.get(agentId) ?? []).filter(
      (run) => run.parentSessionId !== parentSessionId,
    );
    this.unregisterTintinChildren(agentId, parentSessionId);
    if (remaining.length === 0) this.tintinRuns.delete(agentId);
    else this.tintinRuns.set(agentId, remaining);
  }

  private unregisterTintinChildren(
    agentId: string,
    parentSessionId: string,
  ): void {
    for (const [sessionId, info] of this.sessions) {
      if (
        info.tintinAgentId === agentId &&
        info.parentSessionId === parentSessionId
      ) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Match tintinweb's `${name}#${agentId.slice(0, 8)}` child session name.
   * The match is trusted only when exactly one active run has that prefix.
   * Persisted child headers, when present, must name that run's parent file;
   * in-memory sessions without headers rely on the unique active run signal.
   */
  findTintinParent(options: {
    sessionName: string | undefined;
    parentSessionFile?: string;
  }): SubagentSessionInfo | undefined {
    const suffix = options.sessionName?.match(/#([A-Za-z0-9_-]{8})$/)?.[1];
    if (suffix) {
      const matches = [...this.tintinRuns.entries()]
        .filter(([agentId]) => agentId.startsWith(suffix))
        .flatMap(([, runs]) => runs);
      // A tintin-shaped name that collides with a top-level run prefix must
      // not fall through to a different parent's file mapping.
      if (matches.length > 0) {
        if (matches.length !== 1) return undefined;
        const [run] = matches;
        if (!run.parentSessionId) return undefined;
        if (
          options.parentSessionFile !== undefined &&
          run.parentSessionFile !== options.parentSessionFile
        ) {
          return undefined;
        }
        return {
          parentSessionId: run.parentSessionId,
          tintinAgentId: run.agentId,
        };
      }
    }

    // Nested tintin runs intentionally have no top-level lifecycle event. A
    // persisted child's parentSession header names its immediate parent's
    // session file; follow only one unique, still-active mapping. In-memory
    // sessions have no such header and stay fail-closed.
    if (!suffix || !options.parentSessionFile) return undefined;
    const parents = [...this.sessions.values()].filter(
      (info) =>
        info.sessionFile === options.parentSessionFile &&
        info.tintinAgentId !== undefined &&
        this.hasActiveTintinRun(info.tintinAgentId) &&
        info.parentSessionId !== undefined,
    );
    if (parents.length !== 1) return undefined;
    const [parent] = parents;
    return {
      parentSessionId: parent.parentSessionId,
      tintinAgentId: parent.tintinAgentId,
    };
  }

  /** True for tintinweb's eight-character run-ID session-name suffix. */
  hasTintinSessionName(sessionName: string | undefined): boolean {
    return sessionName !== undefined && /#[A-Za-z0-9_-]{8}$/.test(sessionName);
  }
}
