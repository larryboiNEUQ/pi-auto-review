import { createEventBus } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_CHILD_DISPOSED,
  SUBAGENT_CHILD_SESSION_CREATED,
  subscribeSubagentLifecycle,
  subscribeTintinSubagentLifecycle,
} from "#src/authority/subagent-lifecycle-events";
import { SubagentSessionRegistry } from "#src/authority/subagent-registry";

describe("subscribeSubagentLifecycle", () => {
  let registry: SubagentSessionRegistry;

  beforeEach(() => {
    registry = new SubagentSessionRegistry();
  });

  it("registers a child session on session-created", () => {
    const bus = createEventBus();
    subscribeSubagentLifecycle(bus, registry);

    bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-session-abc",
      parentSessionId: "parent-42",
    });

    expect(registry.get("child-session-abc")).toEqual({
      parentSessionId: "parent-42",
    });
  });

  it("populates the registry synchronously — before emit() returns", () => {
    // Guards the pre-bindExtensions ordering: the core emits session-created
    // on the same synchronous call stack right before bindExtensions(), so the
    // handler must complete before emit() returns. A real EventEmitter-backed
    // bus dispatches synchronously; this fails loudly if the handler ever
    // becomes async (awaiting before registry.register).
    const bus = createEventBus();
    subscribeSubagentLifecycle(bus, registry);

    bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-session-sync",
    });

    // No await between emit and this assertion.
    expect(registry.has("child-session-sync")).toBe(true);
  });

  it("omits parentSessionId when the event does not carry one", () => {
    const bus = createEventBus();
    subscribeSubagentLifecycle(bus, registry);

    bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-session-xyz",
    });

    expect(registry.get("child-session-xyz")).toEqual({
      parentSessionId: undefined,
    });
  });

  it("unregisters a child session on disposed", () => {
    const bus = createEventBus();
    subscribeSubagentLifecycle(bus, registry);
    registry.register("child-session-abc", { parentSessionId: "parent-42" });

    bus.emit(SUBAGENT_CHILD_DISPOSED, { sessionId: "child-session-abc" });

    expect(registry.has("child-session-abc")).toBe(false);
  });

  it("detaches both handlers when the returned unsubscribe is called", () => {
    const bus = createEventBus();
    const unsubscribe = subscribeSubagentLifecycle(bus, registry);

    unsubscribe();

    bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-session-abc",
    });
    bus.emit(SUBAGENT_CHILD_DISPOSED, { sessionId: "child-session-abc" });

    expect(registry.has("child-session-abc")).toBe(false);
  });

  it("subscribes to a fake bus on the exact channel names", () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const bus = {
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      }),
    };

    subscribeSubagentLifecycle(bus, registry);

    expect(bus.on).toHaveBeenCalledTimes(2);
    expect(handlers.has("subagents:child:session-created")).toBe(true);
    expect(handlers.has("subagents:child:disposed")).toBe(true);
  });

  it("exposes the canonical channel-name strings", () => {
    expect(SUBAGENT_CHILD_SESSION_CREATED).toBe(
      "subagents:child:session-created",
    );
    expect(SUBAGENT_CHILD_DISPOSED).toBe("subagents:child:disposed");
  });

  // ── #298 regression: concurrent siblings must be independent ──────────────

  it("disposing one sibling does not evict the other (collision regression)", () => {
    const bus = createEventBus();
    subscribeSubagentLifecycle(bus, registry);

    // Two concurrent children of the same parent register under distinct ids.
    bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-A",
      parentSessionId: "parent-P",
    });
    bus.emit(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-B",
      parentSessionId: "parent-P",
    });

    // Sibling A finishes first.
    bus.emit(SUBAGENT_CHILD_DISPOSED, { sessionId: "child-A" });

    // B must still be detected as a registered subagent.
    expect(registry.has("child-A")).toBe(false);
    expect(registry.has("child-B")).toBe(true);
    expect(registry.get("child-B")?.parentSessionId).toBe("parent-P");
  });
});

describe("subscribeTintinSubagentLifecycle", () => {
  let registry: SubagentSessionRegistry;

  beforeEach(() => {
    registry = new SubagentSessionRegistry();
  });

  it("captures top-level starts against an active persisted parent", () => {
    const bus = createEventBus();
    const lifecycle = subscribeTintinSubagentLifecycle(bus, registry);
    lifecycle.setActiveParent({
      sessionId: "parent-1",
      sessionFile: "/sessions/parent-1.jsonl",
    });

    bus.emit("subagents:started", { id: "a1b2c3d4-full-id" });

    expect(
      registry.findTintinParent({
        sessionName: "Explore#a1b2c3d4",
        parentSessionFile: "/sessions/parent-1.jsonl",
      }),
    ).toMatchObject({ parentSessionId: "parent-1" });
  });

  it("captures top-level starts for an active in-memory parent without a file", () => {
    const bus = createEventBus();
    const lifecycle = subscribeTintinSubagentLifecycle(bus, registry);
    lifecycle.setActiveParent({ sessionId: "memory-parent" });

    bus.emit("subagents:started", { id: "a1b2c3d4-memory-run" });

    expect(registry.findTintinParent({
      sessionName: "Explore#a1b2c3d4",
    })).toMatchObject({ parentSessionId: "memory-parent" });
    expect(registry.findTintinParent({
      sessionName: "Explore#a1b2c3d4",
      parentSessionFile: "/sessions/other-parent.jsonl",
    })).toBeUndefined();
  });

  it("ignores starts when there is no active parent", () => {
    const bus = createEventBus();
    const lifecycle = subscribeTintinSubagentLifecycle(bus, registry);

    bus.emit("subagents:started", { id: "inactive-run" });
    expect(registry.hasActiveTintinRun("inactive-run")).toBe(false);
  });

  it("keeps concurrent siblings independent and clears each on completion or failure", () => {
    const bus = createEventBus();
    const lifecycle = subscribeTintinSubagentLifecycle(bus, registry);
    lifecycle.setActiveParent({
      sessionId: "parent-1",
      sessionFile: "/sessions/parent-1.jsonl",
    });
    bus.emit("subagents:started", { id: "sibAA001-full" });
    bus.emit("subagents:started", { id: "sibBB001-full" });
    bus.emit("subagents:completed", { id: "sibAA001-full" });

    expect(registry.hasActiveTintinRun("sibAA001-full")).toBe(false);
    expect(registry.findTintinParent({
      sessionName: "Explore#sibBB001",
      parentSessionFile: "/sessions/parent-1.jsonl",
    })).toMatchObject({ parentSessionId: "parent-1" });

    bus.emit("subagents:failed", { id: "sibBB001-full" });
    expect(registry.hasActiveTintinRun("sibBB001-full")).toBe(false);
  });

  it("clears parent-owned signals when the subscription is disposed", () => {
    const bus = createEventBus();
    const lifecycle = subscribeTintinSubagentLifecycle(bus, registry);
    lifecycle.setActiveParent({
      sessionId: "parent-1",
      sessionFile: "/sessions/parent-1.jsonl",
    });
    bus.emit("subagents:started", { id: "run-1" });

    lifecycle.unsubscribe();

    expect(registry.hasActiveTintinRun("run-1")).toBe(false);
  });

  it("clears stale run signals when the active parent session changes", () => {
    const bus = createEventBus();
    const lifecycle = subscribeTintinSubagentLifecycle(bus, registry);
    lifecycle.setActiveParent({
      sessionId: "parent-1",
      sessionFile: "/sessions/parent-1.jsonl",
    });
    bus.emit("subagents:started", { id: "old-run" });

    lifecycle.setActiveParent({
      sessionId: "parent-2",
      sessionFile: "/sessions/parent-2.jsonl",
    });

    expect(registry.hasActiveTintinRun("old-run")).toBe(false);
  });
});
