/**
 * subagent-lifecycle-events.ts — Adapt native and tintinweb lifecycle signals
 * into the SubagentSessionRegistry.
 *
 * @gotgenes/pi-subagents publishes its child-execution lifecycle on the Pi
 * event bus (ADR 0002): it no longer calls this package's service directly.
 * We register the child on `session-created` and unregister it on `disposed`.
 *
 * The channel names and payload shapes are declared independently here (the two
 * packages must not depend on each other under jiti) and MUST match the
 * publisher in `@gotgenes/pi-subagents` (`src/lifecycle/child-lifecycle.ts`).
 *
 * The `session-created` handler MUST stay synchronous: the core emits it on the
 * same synchronous call stack immediately before `bindExtensions()`, and the
 * event bus dispatches listeners synchronously, so a synchronous handler lands
 * the registry entry before binding proceeds. Introducing an `await` before
 * `registry.register(...)` would break the pre-bind ordering.
 */

import type {
  SubagentSessionRegistry,
  TintinSubagentRun,
} from "./subagent-registry";

/** Emitted by the core after session creation, before `bindExtensions()`. */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";

/** Emitted by the core in the run's `finally` (success and error). */
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

/** Minimal event-bus surface this module needs (subscribe only). */
interface LifecycleEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Fields read from the `session-created` payload (ISP). */
interface ChildSessionCreatedEvent {
  /** Child session id — the registry key. Must match the publisher. */
  sessionId: string;
  parentSessionId?: string;
}

/** Fields read from the `disposed` payload (ISP). */
interface ChildDisposedEvent {
  /** Child session id — the registry key. Must match the publisher. */
  sessionId: string;
}

/**
 * Subscribe to the subagent child lifecycle.
 *
 * @returns an unsubscribe that detaches both handlers (call during
 *          `session_shutdown`).
 */
export function subscribeSubagentLifecycle(
  events: LifecycleEventBus,
  registry: SubagentSessionRegistry,
): () => void {
  const unsubCreated = events.on(SUBAGENT_CHILD_SESSION_CREATED, (data) => {
    const event = data as ChildSessionCreatedEvent;
    registry.register(event.sessionId, {
      parentSessionId: event.parentSessionId,
    });
  });

  const unsubDisposed = events.on(SUBAGENT_CHILD_DISPOSED, (data) => {
    const event = data as ChildDisposedEvent;
    registry.unregister(event.sessionId);
  });

  return () => {
    unsubCreated();
    unsubDisposed();
  };
}

/** Parent identity observed when tintinweb starts a top-level child run. */
export interface ActiveTintinParent {
  sessionId: string;
  sessionFile?: string;
}

export interface TintinSubagentLifecycleSubscription {
  /** Replace the active serving session, clearing signals from a prior one. */
  setActiveParent(parent: ActiveTintinParent | null): void;
  /** Detach event listeners and clear signals owned by this subscription. */
  unsubscribe(): void;
}

/**
 * Subscribe to tintinweb's existing top-level run events. The child session
 * does not have a session ID in `subagents:started`, so the parent signal is
 * indexed by its full agent ID until the child extension binds. The child then
 * matches the short ID suffix in its session name, then verifies its persisted
 * `parentSession` header against the parent file when the header is present.
 */
export function subscribeTintinSubagentLifecycle(
  events: LifecycleEventBus,
  registry: SubagentSessionRegistry,
): TintinSubagentLifecycleSubscription {
  const observedParents = new Set<string>();
  const ownedRuns = new Map<string, Set<string>>();
  let activeParent: ActiveTintinParent | null = null;
  const readAgentId = (data: unknown): string | null => {
    if (typeof data !== "object" || data === null) return null;
    const id = (data as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  };

  const unsubStarted = events.on("subagents:started", (data) => {
    const agentId = readAgentId(data);
    if (!agentId) return;
    const parent = activeParent;
    if (!parent?.sessionId) return;
    const run: TintinSubagentRun = {
      agentId,
      parentSessionId: parent.sessionId,
      parentSessionFile: parent.sessionFile,
    };
    registry.startTintinRun(run);
    observedParents.add(parent.sessionId);
    const parents = ownedRuns.get(agentId) ?? new Set<string>();
    parents.add(parent.sessionId);
    ownedRuns.set(agentId, parents);
  });

  const finish = (data: unknown) => {
    const agentId = readAgentId(data);
    if (!agentId) return;
    for (const parentSessionId of ownedRuns.get(agentId) ?? []) {
      registry.finishTintinRun(agentId, parentSessionId);
    }
    ownedRuns.delete(agentId);
  };
  const unsubCompleted = events.on("subagents:completed", finish);
  const unsubFailed = events.on("subagents:failed", finish);

  return {
    setActiveParent(parent) {
      if (
        activeParent &&
        (activeParent.sessionId !== parent?.sessionId ||
          activeParent.sessionFile !== parent?.sessionFile)
      ) {
        registry.clearTintinRunsForParent(activeParent.sessionId);
      }
      activeParent = parent;
    },
    unsubscribe() {
      unsubStarted();
      unsubCompleted();
      unsubFailed();
      for (const parentSessionId of observedParents) {
        registry.clearTintinRunsForParent(parentSessionId);
      }
      activeParent = null;
    },
  };
}
