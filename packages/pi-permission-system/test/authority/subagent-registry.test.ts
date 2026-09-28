import { afterEach, describe, expect, test } from "vitest";
import {
  getSubagentSessionRegistry,
  type SubagentSessionInfo,
  SubagentSessionRegistry,
} from "#src/authority/subagent-registry";

const REGISTRY_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:subagent-registry",
);

function makeInfo(
  overrides: Partial<SubagentSessionInfo> = {},
): SubagentSessionInfo {
  return { ...overrides };
}

describe("SubagentSessionRegistry", () => {
  test("has() returns false for an unregistered key", () => {
    const registry = new SubagentSessionRegistry();
    expect(registry.has("session-abc")).toBe(false);
  });

  test("get() returns undefined for an unregistered key", () => {
    const registry = new SubagentSessionRegistry();
    expect(registry.get("session-abc")).toBeUndefined();
  });

  test("has() returns true after register()", () => {
    const registry = new SubagentSessionRegistry();
    registry.register("session-abc", makeInfo());
    expect(registry.has("session-abc")).toBe(true);
  });

  test("get() returns the registered info after register()", () => {
    const registry = new SubagentSessionRegistry();
    const info = makeInfo({ parentSessionId: "parent-123" });
    registry.register("session-abc", info);
    expect(registry.get("session-abc")).toEqual(info);
  });

  test("register() stores entry without parentSessionId", () => {
    const registry = new SubagentSessionRegistry();
    registry.register("session-abc", makeInfo());
    expect(registry.get("session-abc")).toEqual({});
  });

  test("has() returns false after unregister()", () => {
    const registry = new SubagentSessionRegistry();
    registry.register("session-abc", makeInfo());
    registry.unregister("session-abc");
    expect(registry.has("session-abc")).toBe(false);
  });

  test("get() returns undefined after unregister()", () => {
    const registry = new SubagentSessionRegistry();
    registry.register("session-abc", makeInfo());
    registry.unregister("session-abc");
    expect(registry.get("session-abc")).toBeUndefined();
  });

  test("unregister() is a no-op for an unknown key", () => {
    const registry = new SubagentSessionRegistry();
    expect(() => registry.unregister("session-nonexistent")).not.toThrow();
  });

  test("register() overwrites a previous entry for the same key", () => {
    const registry = new SubagentSessionRegistry();
    registry.register("session-abc", makeInfo({ parentSessionId: "parent-1" }));
    registry.register("session-abc", makeInfo({ parentSessionId: "parent-2" }));
    expect(registry.get("session-abc")?.parentSessionId).toBe("parent-2");
  });

  // ── #298 regression: concurrent siblings must be independent ──────────────

  test("two sibling session ids are registered independently", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(
      "child-session-A",
      makeInfo({ parentSessionId: "parent-P" }),
    );
    registry.register(
      "child-session-B",
      makeInfo({ parentSessionId: "parent-P" }),
    );

    expect(registry.has("child-session-A")).toBe(true);
    expect(registry.has("child-session-B")).toBe(true);
  });

  test("disposing one sibling does not evict the other (collision regression)", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(
      "child-session-A",
      makeInfo({ parentSessionId: "parent-P" }),
    );
    registry.register(
      "child-session-B",
      makeInfo({ parentSessionId: "parent-P" }),
    );

    // Sibling A finishes — should not affect B.
    registry.unregister("child-session-A");

    expect(registry.has("child-session-A")).toBe(false);
    expect(registry.has("child-session-B")).toBe(true);
    expect(registry.get("child-session-B")?.parentSessionId).toBe("parent-P");
  });

  test("matches a child only to a unique active ID prefix and persisted parent", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "a1b2c3d4-full-id",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
    });

    expect(
      registry.findTintinParent({
        sessionName: "Explore#a1b2c3d4",
        parentSessionFile: "/sessions/parent-1.jsonl",
      }),
    ).toEqual({
      parentSessionId: "parent-1",
      tintinAgentId: "a1b2c3d4-full-id",
    });
    expect(
      registry.findTintinParent({
        sessionName: "Explore#a1b2c3d4",
        parentSessionFile: "/sessions/unrelated.jsonl",
      }),
    ).toBeUndefined();
  });

  test("rejects a colliding short prefix", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "a1b2c3d4-first",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
    });
    registry.startTintinRun({
      agentId: "a1b2c3d4-second",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
    });

    expect(
      registry.findTintinParent({
        sessionName: "Explore#a1b2c3d4",
        parentSessionFile: "/sessions/parent-1.jsonl",
      }),
    ).toBeUndefined();
  });

  test("matches a unique active run without a child header and rejects it when stale", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "a1b2c3d4-active",
      parentSessionId: "parent-1",
    });

    expect(registry.findTintinParent({
      sessionName: "Explore#a1b2c3d4",
    })).toMatchObject({ parentSessionId: "parent-1" });

    registry.finishTintinRun("a1b2c3d4-active", "parent-1");
    expect(registry.findTintinParent({
      sessionName: "Explore#a1b2c3d4",
    })).toBeUndefined();
  });

  test("removes completed runs and parent-owned runs on shutdown", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "child-complete",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
    });
    registry.startTintinRun({
      agentId: "child-other-parent",
      parentSessionId: "parent-2",
      parentSessionFile: "/sessions/parent-2.jsonl",
    });
    registry.register("child-session-1", {
      parentSessionId: "parent-1",
      tintinAgentId: "child-complete",
    });
    registry.register("child-session-2", {
      parentSessionId: "parent-2",
      tintinAgentId: "child-other-parent",
    });
    registry.finishTintinRun("child-complete", "parent-1");
    registry.clearTintinRunsForParent("parent-2");

    expect(registry.hasActiveTintinRun("child-complete")).toBe(false);
    expect(registry.hasActiveTintinRun("child-other-parent")).toBe(false);
    expect(registry.has("child-session-1")).toBe(false);
    expect(registry.has("child-session-2")).toBe(false);
  });
});

// ── process-global accessor ────────────────────────────────────────────────

describe("getSubagentSessionRegistry (process-global accessor)", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; Map.delete() is not applicable
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
  });

  test("returns a SubagentSessionRegistry instance", () => {
    const registry = getSubagentSessionRegistry();
    expect(registry).toBeInstanceOf(SubagentSessionRegistry);
  });

  test("returns the same instance on repeated calls", () => {
    const first = getSubagentSessionRegistry();
    const second = getSubagentSessionRegistry();
    expect(first).toBe(second);
  });

  test("state registered through one call is visible through another call", () => {
    const writer = getSubagentSessionRegistry();
    writer.register("child-session-xyz", {
      parentSessionId: "parent-abc",
    });

    const reader = getSubagentSessionRegistry();
    expect(reader.has("child-session-xyz")).toBe(true);
    expect(reader.get("child-session-xyz")?.parentSessionId).toBe("parent-abc");
  });

  test("starts empty on first call", () => {
    const registry = getSubagentSessionRegistry();
    expect(registry.has("any-session-id")).toBe(false);
  });
});
