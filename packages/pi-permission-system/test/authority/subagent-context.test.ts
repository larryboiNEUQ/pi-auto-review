import { afterEach, describe, expect, test, vi } from "vitest";
import { SUBAGENT_ENV_HINT_KEYS } from "#src/authority/permission-forwarding";
import {
  isRegisteredSubagentChild,
  isSubagentExecutionContext,
  normalizeFilesystemPath,
  type SubagentDetectionContext,
} from "#src/authority/subagent-context";
import { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import { posixPathFlavor, win32PathFlavor } from "#src/path/path-flavor";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function makeCtx(
  sessionDir: string | null,
  sessionId: string = "",
): SubagentDetectionContext {
  return {
    sessionManager: {
      getSessionDir: vi.fn(() => sessionDir ?? ""),
      getSessionId: vi.fn(() => sessionId),
    },
  };
}

describe("isRegisteredSubagentChild", () => {
  const childSessionId = "child-session-abc";

  test("returns true when the session id is registered", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {});
    expect(
      isRegisteredSubagentChild(makeCtx(null, childSessionId), registry),
    ).toBe(true);
  });

  test("returns false when the session id is not registered", () => {
    const registry = new SubagentSessionRegistry();
    expect(
      isRegisteredSubagentChild(makeCtx(null, childSessionId), registry),
    ).toBe(false);
  });

  test("returns false when the session id is empty", () => {
    const registry = new SubagentSessionRegistry();
    registry.register("", {});
    expect(isRegisteredSubagentChild(makeCtx(null, ""), registry)).toBe(false);
  });

  test("returns false when getSessionId throws", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {});
    const ctx: SubagentDetectionContext = {
      sessionManager: {
        getSessionDir: vi.fn(() => ""),
        getSessionId: vi.fn(() => {
          throw new Error("session id unavailable");
        }),
      },
    };
    expect(isRegisteredSubagentChild(ctx, registry)).toBe(false);
  });
});

describe("normalizeFilesystemPath", () => {
  test("normalizes a simple absolute path", () => {
    expect(normalizeFilesystemPath("/projects/my-app", posixPathFlavor)).toBe(
      "/projects/my-app",
    );
  });

  test("collapses redundant separators", () => {
    expect(normalizeFilesystemPath("/projects//my-app", posixPathFlavor)).toBe(
      "/projects/my-app",
    );
  });

  test("resolves . and .. segments", () => {
    expect(
      normalizeFilesystemPath("/projects/my-app/../other", posixPathFlavor),
    ).toBe("/projects/other");
  });

  test("win32: lowercases and normalizes with win32 separators", () => {
    expect(
      normalizeFilesystemPath("C:\\Projects\\My-App", win32PathFlavor),
    ).toBe("c:\\projects\\my-app");
  });

  test("posix: leaves case untouched", () => {
    expect(normalizeFilesystemPath("/Projects/My-App", posixPathFlavor)).toBe(
      "/Projects/My-App",
    );
  });
});

describe("isSubagentExecutionContext — injected platform (#510)", () => {
  test("win32: detects a subagent session dir case-insensitively", () => {
    const subagentRoot = "C:\\Sessions\\Subagents";
    const sessionDir = "c:\\sessions\\subagents\\child";
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        win32PathFlavor,
      ),
    ).toBe(true);
  });

  test("posix: the same mixed-case dir is not a subagent context", () => {
    const subagentRoot = "/Sessions/Subagents";
    const sessionDir = "/sessions/subagents/child";
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(false);
  });
});

describe("isSubagentExecutionContext — env hint detection", () => {
  test("returns true when PI_IS_SUBAGENT is set", () => {
    vi.stubEnv("PI_IS_SUBAGENT", "true");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_SESSION_ID is set", () => {
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "abc123");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_AGENT_ROUTER_SUBAGENT is set", () => {
    vi.stubEnv("PI_AGENT_ROUTER_SUBAGENT", "1");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  // nicobailon/pi-subagents keys
  test("returns true when PI_SUBAGENT_CHILD is set", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_RUN_ID is set", () => {
    vi.stubEnv("PI_SUBAGENT_RUN_ID", "run-abc");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_CHILD_AGENT is set", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "worker");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_DEPTH is set", () => {
    vi.stubEnv("PI_SUBAGENT_DEPTH", "1");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_DEPTH is zero (depth-0 is still a subagent context)", () => {
    vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  // HazAT/pi-interactive-subagents keys
  test("returns true when PI_SUBAGENT_NAME is set", () => {
    vi.stubEnv("PI_SUBAGENT_NAME", "my-agent");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_ID is set", () => {
    vi.stubEnv("PI_SUBAGENT_ID", "id-xyz");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_SESSION is set", () => {
    vi.stubEnv("PI_SUBAGENT_SESSION", "session-xyz");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when PI_SUBAGENT_ACTIVITY_FILE is set", () => {
    vi.stubEnv("PI_SUBAGENT_ACTIVITY_FILE", "/tmp/activity.json");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("covers all declared SUBAGENT_ENV_HINT_KEYS", () => {
    // Verify the keys we test match what the module declares.
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_IS_SUBAGENT");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_SESSION_ID");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_AGENT_ROUTER_SUBAGENT");
    // nicobailon/pi-subagents
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_CHILD");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_RUN_ID");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_CHILD_AGENT");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_DEPTH");
    // HazAT/pi-interactive-subagents
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_NAME");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_ID");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_SESSION");
    expect(SUBAGENT_ENV_HINT_KEYS).toContain("PI_SUBAGENT_ACTIVITY_FILE");
  });

  test("returns false when env hint value is empty string", () => {
    vi.stubEnv("PI_IS_SUBAGENT", "");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(false);
  });

  test("returns false when env hint value is whitespace only", () => {
    vi.stubEnv("PI_IS_SUBAGENT", "   ");
    expect(
      isSubagentExecutionContext(
        makeCtx(null),
        "/sessions/subagents",
        posixPathFlavor,
      ),
    ).toBe(false);
  });
});

describe("isSubagentExecutionContext — session dir detection", () => {
  const subagentRoot = "/home/user/.pi/agent/sessions/subagents";

  test("returns true when session dir is within subagent root", () => {
    const sessionDir = `${subagentRoot}/session-abc`;
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when session dir equals subagent root", () => {
    expect(
      isSubagentExecutionContext(
        makeCtx(subagentRoot),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns false when session dir is outside subagent root", () => {
    const sessionDir = "/home/user/.pi/agent/sessions/main-session";
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(false);
  });

  test("returns false when session dir is a sibling with shared prefix", () => {
    // "/sessions/subagents-extra" should not match root "/sessions/subagents"
    const sessionDir = `${subagentRoot}-extra/session-abc`;
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(false);
  });

  test("returns false when a `..` segment escapes the subagent root", () => {
    // Normalizes to /home/user/.pi/agent/sessions/evil/session-abc — outside.
    const sessionDir = `${subagentRoot}/../evil/session-abc`;
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(false);
  });

  test("returns true when a `..` segment resolves back inside the root", () => {
    // Normalizes to /home/user/.pi/agent/sessions/subagents/session-abc — inside.
    const sessionDir = `${subagentRoot}/nested/../session-abc`;
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(true);
  });

  test("returns false when session dir is under a different root", () => {
    const sessionDir = "/var/other/subagents/session-abc";
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        posixPathFlavor,
      ),
    ).toBe(false);
  });

  test("returns false when getSessionDir returns null", () => {
    expect(
      isSubagentExecutionContext(makeCtx(null), subagentRoot, posixPathFlavor),
    ).toBe(false);
  });

  test("returns false when getSessionDir returns empty string", () => {
    expect(
      isSubagentExecutionContext(makeCtx(""), subagentRoot, posixPathFlavor),
    ).toBe(false);
  });
});

describe("isSubagentExecutionContext — session dir detection (win32 flavor)", () => {
  const subagentRoot = "C:\\Users\\dev\\.pi\\agent\\sessions\\subagents";

  test("returns true when session dir is within subagent root", () => {
    const sessionDir = `${subagentRoot}\\session-abc`;
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        win32PathFlavor,
      ),
    ).toBe(true);
  });

  test("returns true when session dir equals subagent root (case-insensitive)", () => {
    expect(
      isSubagentExecutionContext(
        makeCtx(subagentRoot.toUpperCase()),
        subagentRoot,
        win32PathFlavor,
      ),
    ).toBe(true);
  });

  test("returns false when session dir is a sibling with shared prefix", () => {
    const sessionDir = `${subagentRoot}-extra\\session-abc`;
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        win32PathFlavor,
      ),
    ).toBe(false);
  });

  test("returns false when a `..` segment escapes the subagent root", () => {
    const sessionDir = `${subagentRoot}\\..\\evil\\session-abc`;
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        win32PathFlavor,
      ),
    ).toBe(false);
  });

  test("returns false when session dir is on a different drive", () => {
    const sessionDir =
      "D:\\Users\\dev\\.pi\\agent\\sessions\\subagents\\session-abc";
    expect(
      isSubagentExecutionContext(
        makeCtx(sessionDir),
        subagentRoot,
        win32PathFlavor,
      ),
    ).toBe(false);
  });
});

describe("isSubagentExecutionContext — registry detection", () => {
  const subagentRoot = "/home/user/.pi/agent/sessions/subagents";
  const outsideDir =
    "/home/user/projects/my-app/.pi/agent/sessions/parent/tasks";
  const childSessionId = "child-session-abc";

  test("returns true when session id is registered (no env vars, dir outside filesystem root)", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {});
    expect(
      isSubagentExecutionContext(
        makeCtx(outsideDir, childSessionId),
        subagentRoot,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
  });

  test("returns true when registered session has a parentSessionId", () => {
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, { parentSessionId: "parent-123" });
    expect(
      isSubagentExecutionContext(
        makeCtx(outsideDir, childSessionId),
        subagentRoot,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
  });

  test("returns false when registry is provided but session id is not registered", () => {
    const registry = new SubagentSessionRegistry();
    expect(
      isSubagentExecutionContext(
        makeCtx(outsideDir, childSessionId),
        subagentRoot,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
  });

  test("returns false when session id is empty and registry has no matching entry", () => {
    const registry = new SubagentSessionRegistry();
    expect(
      isSubagentExecutionContext(
        makeCtx(null, ""),
        subagentRoot,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
  });

  test("registry check takes priority over env var detection", () => {
    // Registry says registered; env var not set — should still return true.
    const registry = new SubagentSessionRegistry();
    registry.register(childSessionId, {});
    // Confirm no env var is set
    expect(process.env.PI_IS_SUBAGENT).toBeUndefined();
    expect(
      isSubagentExecutionContext(
        makeCtx(outsideDir, childSessionId),
        subagentRoot,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
  });

  test("unregistered session falls through to env var detection", () => {
    vi.stubEnv("PI_IS_SUBAGENT", "true");
    const registry = new SubagentSessionRegistry(); // empty — childSessionId not registered
    // Env var present → still true even without registry entry
    expect(
      isSubagentExecutionContext(
        makeCtx(outsideDir, childSessionId),
        subagentRoot,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
  });

  test("no registry passed — existing behaviour unchanged", () => {
    // Ensure the parameter is truly optional (no registry arg)
    expect(
      isSubagentExecutionContext(makeCtx(null), subagentRoot, posixPathFlavor),
    ).toBe(false);
  });
});

describe("isSubagentExecutionContext — tintinweb run lineage", () => {
  const subagentSessionsDir = "/sessions/subagents";

  function makeTintinCtx(options: {
    sessionId: string;
    sessionName?: string;
    parentSession?: string;
    sessionFile?: string;
    sessionDir?: string;
  }): SubagentDetectionContext {
    return {
      sessionManager: {
        getSessionId: () => options.sessionId,
        getSessionDir: () => options.sessionDir ?? "/sessions/ordinary",
        getSessionFile: () => options.sessionFile,
        getSessionName: () => options.sessionName,
        getHeader: () =>
          options.parentSession
            ? { parentSession: options.parentSession }
            : null,
      },
    };
  }

  test("registers child lineage before authorizer selection when ID and parent header match", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "a1b2c3d4-full-id",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
    });
    const ctx = makeTintinCtx({
      sessionId: "child-1",
      sessionName: "Explore#a1b2c3d4",
      parentSession: "/sessions/parent-1.jsonl",
    });

    expect(
      isSubagentExecutionContext(
        ctx,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
    expect(registry.get("child-1")).toMatchObject({
      parentSessionId: "parent-1",
      tintinAgentId: "a1b2c3d4-full-id",
    });
  });

  test("does not trust a child header for a different parent file", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "a1b2c3d4-full-id",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
    });

    expect(
      isSubagentExecutionContext(
        makeTintinCtx({
          sessionId: "child-1",
          sessionName: "Explore#a1b2c3d4",
          parentSession: "/sessions/other-parent.jsonl",
        }),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    expect(registry.has("child-1")).toBe(false);
  });

  test("rejects an ambiguous prefix and a child with no trusted signal", () => {
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

    const collision = makeTintinCtx({
      sessionId: "child-collision",
      sessionName: "Explore#a1b2c3d4",
    });
    const noSignal = makeTintinCtx({
      sessionId: "child-unknown",
      sessionName: "Explore#unknown8",
    });

    expect(
      isSubagentExecutionContext(
        collision,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    expect(
      isSubagentExecutionContext(
        noSignal,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
  });

  test("does not promote an untrusted tintin-shaped name through a generic env hint", () => {
    vi.stubEnv("PI_IS_SUBAGENT", "1");
    const registry = new SubagentSessionRegistry();

    expect(
      isSubagentExecutionContext(
        makeTintinCtx({
          sessionId: "child-unknown",
          sessionName: "Explore#unknown8",
          parentSession: "/sessions/parent.jsonl",
        }),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
  });

  test("parent completion invalidates a previously associated child", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "a1b2c3d4-full-id",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
    });
    const ctx = makeTintinCtx({
      sessionId: "child-1",
      sessionName: "Explore#a1b2c3d4",
    });
    expect(
      isSubagentExecutionContext(ctx, subagentSessionsDir, posixPathFlavor, registry),
    ).toBe(true);

    registry.finishTintinRun("a1b2c3d4-full-id", "parent-1");

    expect(
      isSubagentExecutionContext(ctx, subagentSessionsDir, posixPathFlavor, registry),
    ).toBe(false);
    expect(registry.has("child-1")).toBe(false);
  });

  test("experimental fallback stays off by default", () => {
    vi.stubEnv("PI_PERMISSION_EXPERIMENTAL_NESTED_FORWARDING", "");
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "active001-full-run",
      parentSessionId: "root-ui-session",
    });

    expect(
      isSubagentExecutionContext(
        makeTintinCtx({
          sessionId: "nested-memory-child",
          sessionName: "Review#unknown1",
        }),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    expect(registry.has("nested-memory-child")).toBe(false);
  });

  test("opt-in experimental fallback uses the sole active root run for a headerless nested child", () => {
    vi.stubEnv("PI_PERMISSION_EXPERIMENTAL_NESTED_FORWARDING", "1");
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "active001-full-run",
      parentSessionId: "root-ui-session",
    });
    const child = makeTintinCtx({
      sessionId: "nested-memory-child",
      sessionName: "Review#unknown1",
    });

    expect(
      isSubagentExecutionContext(
        child,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
    expect(registry.get("nested-memory-child")).toMatchObject({
      parentSessionId: "root-ui-session",
      tintinAgentId: "active001-full-run",
    });
  });

  test("experimental fallback rejects multiple active runs and ordinary sessions", () => {
    vi.stubEnv("PI_PERMISSION_EXPERIMENTAL_NESTED_FORWARDING", "1");
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "active001-first-run",
      parentSessionId: "root-ui-one",
    });
    registry.startTintinRun({
      agentId: "active002-second-run",
      parentSessionId: "root-ui-two",
    });

    expect(
      isSubagentExecutionContext(
        makeTintinCtx({
          sessionId: "ambiguous-child",
          sessionName: "Review#unknown1",
        }),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    expect(
      isSubagentExecutionContext(
        makeTintinCtx({ sessionId: "ordinary-session", sessionName: "worker" }),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
  });

  test("experimental fallback never overrides a present mismatched header", () => {
    vi.stubEnv("PI_PERMISSION_EXPERIMENTAL_NESTED_FORWARDING", "1");
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "active001-full-run",
      parentSessionId: "root-ui-session",
    });

    expect(
      isSubagentExecutionContext(
        makeTintinCtx({
          sessionId: "mismatched-child",
          sessionName: "Review#unknown1",
          parentSession: "/sessions/another-parent.jsonl",
        }),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    expect(registry.has("mismatched-child")).toBe(false);
  });

  test("experimental association is invalidated when its root run completes", () => {
    vi.stubEnv("PI_PERMISSION_EXPERIMENTAL_NESTED_FORWARDING", "1");
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "active001-full-run",
      parentSessionId: "root-ui-session",
    });
    const child = makeTintinCtx({
      sessionId: "nested-memory-child",
      sessionName: "Review#unknown1",
    });
    expect(
      isSubagentExecutionContext(
        child,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);

    registry.finishTintinRun("active001-full-run", "root-ui-session");

    expect(
      isSubagentExecutionContext(
        child,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    expect(registry.has("nested-memory-child")).toBe(false);
  });

  test("follows exact persisted parent files through nested and deeper descendants", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "outer000-full-run-id",
      parentSessionId: "root-ui-session",
      parentSessionFile: "/sessions/root.jsonl",
    });

    const outer = makeTintinCtx({
      sessionId: "outer-session",
      sessionName: "Explore#outer000",
      parentSession: "/sessions/root.jsonl",
      sessionFile: "/sessions/outer.jsonl",
    });
    expect(
      isSubagentExecutionContext(
        outer,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);

    const nested = makeTintinCtx({
      sessionId: "nested-session",
      sessionName: "Review#nested00",
      parentSession: "/sessions/outer.jsonl",
      sessionFile: "/sessions/nested.jsonl",
    });
    expect(
      isSubagentExecutionContext(
        nested,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
    expect(registry.get("nested-session")).toMatchObject({
      parentSessionId: "root-ui-session",
      tintinAgentId: "outer000-full-run-id",
      sessionFile: "/sessions/nested.jsonl",
    });

    const deeper = makeTintinCtx({
      sessionId: "deeper-session",
      sessionName: "Implement#deeper00",
      parentSession: "/sessions/nested.jsonl",
      sessionFile: "/sessions/deeper.jsonl",
    });
    expect(
      isSubagentExecutionContext(
        deeper,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);
    expect(registry.get("deeper-session")).toMatchObject({
      parentSessionId: "root-ui-session",
      tintinAgentId: "outer000-full-run-id",
    });

    registry.finishTintinRun("outer000-full-run-id", "root-ui-session");
    expect(registry.has("outer-session")).toBe(false);
    expect(registry.has("nested-session")).toBe(false);
    expect(registry.has("deeper-session")).toBe(false);
    expect(
      isSubagentExecutionContext(
        deeper,
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
  });

  test("rejects missing, mismatched, ambiguous, and stale persisted parent mappings", () => {
    const registry = new SubagentSessionRegistry();
    registry.startTintinRun({
      agentId: "outer000-live-run",
      parentSessionId: "root-ui-session",
      parentSessionFile: "/sessions/root.jsonl",
    });
    expect(
      isSubagentExecutionContext(
        makeTintinCtx({
          sessionId: "outer-session",
          sessionName: "Explore#outer000",
          parentSession: "/sessions/root.jsonl",
          sessionFile: "/sessions/outer.jsonl",
        }),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(true);

    const nested = (sessionId: string, parentSession: string) => makeTintinCtx({
      sessionId,
      sessionName: "Review#nested00",
      parentSession,
    });
    expect(
      isSubagentExecutionContext(
        nested("missing-header", ""),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    expect(
      isSubagentExecutionContext(
        nested("mismatched-parent", "/sessions/elsewhere.jsonl"),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);

    registry.register("duplicate-file", {
      parentSessionId: "other-root",
      tintinAgentId: "outer000-live-run",
      sessionFile: "/sessions/outer.jsonl",
    });
    expect(
      isSubagentExecutionContext(
        nested("ambiguous-parent", "/sessions/outer.jsonl"),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
    registry.unregister("duplicate-file");

    registry.finishTintinRun("outer000-live-run", "root-ui-session");
    expect(
      isSubagentExecutionContext(
        nested("stale-parent", "/sessions/outer.jsonl"),
        subagentSessionsDir,
        posixPathFlavor,
        registry,
      ),
    ).toBe(false);
  });
});
