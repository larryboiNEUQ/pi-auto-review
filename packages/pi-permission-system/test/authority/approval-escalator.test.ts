import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ParentAuthorizer } from "#src/authority/approval-escalator";
import {
  resolvePermissionForwardingTargetSessionId,
  type ForwardedPermissionRequest,
} from "#src/authority/permission-forwarding";
import { isSubagentExecutionContext } from "#src/authority/subagent-context";
import { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import { posixPathFlavor } from "#src/path/path-flavor";
import {
  createForwardingTempDir,
  makeForwarderContext,
  makeSubagentRegistry,
} from "#test/helpers/forwarding-fixtures";

// ── Local poll helper ────────────────────────────────────────────────────
//
// The reverse direction of `ForwardingTempDir.writeRequest`: waits for the
// request file ParentAuthorizer.authorize writes, so the test can respond
// as the parent session would. Real timers/filesystem, matching how
// composition-root.test.ts's forwarding round trip already behaves.

async function waitForRequestFile(
  requestsDir: string,
): Promise<ForwardedPermissionRequest> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try {
      files = readdirSync(requestsDir).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    const requestFile = files[0];
    if (requestFile) {
      return JSON.parse(
        readFileSync(join(requestsDir, requestFile), "utf-8"),
      ) as ForwardedPermissionRequest;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a request file in ${requestsDir}`);
}

// ── ParentAuthorizer ──────────────────────────────────────────────────────

describe("ParentAuthorizer", () => {
  test("writes a forwarded request carrying the display fields and resolves with the parent's response", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        {
          forwardingDir: temp.forwardingDir,
          registry,
          logger: { review: () => {}, debug: () => {} },
        },
      );

      const decisionPromise = authorizer.authorize({
        requestId: "unused-by-parent-authorizer",
        source: "tool_call",
        agentName: "Explore",
        message: "Allow git push?",
        toolName: "bash",
        command: "git push",
      });

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.targetSessionId).toBe("parent-session");
      expect(request.requesterSessionId).toBe("child-session");
      expect(request.source).toBe("tool_call");
      expect(request.surface).toBe("bash");
      expect(request.value).toBe("git push");

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );

      // toMatchObject: the response also carries a live respondedAt timestamp
      // and the responderSessionId/denialReason passthrough fields.
      await expect(decisionPromise).resolves.toMatchObject({
        approved: true,
        state: "approved",
      });
    } finally {
      temp.cleanup();
    }
  });

  test(
    "forwards a persisted nested child approval to the root UI and returns its decision",
    async () => {
      const temp = createForwardingTempDir("root-ui-session");
      try {
        const registry = new SubagentSessionRegistry();
        registry.startTintinRun({
          agentId: "outer000-full-run-id",
          parentSessionId: "root-ui-session",
          parentSessionFile: "/sessions/root.jsonl",
        });
        const outerContext = {
          sessionManager: {
            getSessionId: () => "outer-session",
            getSessionDir: () => "/sessions/tintin",
            getSessionName: () => "Explore#outer000",
            getSessionFile: () => "/sessions/outer.jsonl",
            getHeader: () => ({ parentSession: "/sessions/root.jsonl" }),
          },
        };
        expect(
          isSubagentExecutionContext(
            outerContext,
            "/sessions/subagents",
            posixPathFlavor,
            registry,
          ),
        ).toBe(true);

        const nestedContext = {
          sessionManager: {
            getSessionId: () => "nested-session",
            getSessionDir: () => "/sessions/tintin",
            getSessionName: () => "Review#nested00",
            getSessionFile: () => "/sessions/nested.jsonl",
            getHeader: () => ({ parentSession: "/sessions/outer.jsonl" }),
          },
        };
        expect(
          isSubagentExecutionContext(
            nestedContext,
            "/sessions/subagents",
            posixPathFlavor,
            registry,
          ),
        ).toBe(true);
        expect(
          resolvePermissionForwardingTargetSessionId({
            hasUI: false,
            isSubagent: true,
            sessionId: "nested-session",
            registry,
            env: {},
          }),
        ).toBe("root-ui-session");

        const authorizer = new ParentAuthorizer(
          makeForwarderContext({ hasUI: false, sessionId: "nested-session" }),
          {
            forwardingDir: temp.forwardingDir,
            registry,
            logger: { review: () => {}, debug: () => {} },
          },
        );
        const decisionPromise = authorizer.authorize({
          requestId: "tool-call-identity-42",
          source: "tool_call",
          agentName: "Review",
          message: "Allow git push?",
          toolName: "bash",
          command: "git push",
        });
        const request = await waitForRequestFile(temp.location.requestsDir);
        expect(request.targetSessionId).toBe("root-ui-session");
        expect(request.requesterSessionId).toBe("nested-session");
        expect(request.message).toBe("Allow git push?");
        writeFileSync(
          join(temp.location.responsesDir, `${request.id}.json`),
          JSON.stringify({
            approved: true,
            state: "approved",
            responderSessionId: "root-ui-session",
          }),
          "utf-8",
        );
        await expect(decisionPromise).resolves.toMatchObject({
          approved: true,
          state: "approved",
        });

        registry.finishTintinRun("outer000-full-run-id", "root-ui-session");
        expect(registry.has("outer-session")).toBe(false);
        expect(registry.has("nested-session")).toBe(false);
      } finally {
        temp.cleanup();
      }
    },
  );

  test(
    "experimental in-memory nested fallback forwards an approval through the sole active root",
    async () => {
      vi.stubEnv("PI_PERMISSION_EXPERIMENTAL_NESTED_FORWARDING", "1");
      const temp = createForwardingTempDir("root-ui-session");
      try {
        const registry = new SubagentSessionRegistry();
        registry.startTintinRun({
          agentId: "outer000-full-run-id",
          parentSessionId: "root-ui-session",
          parentSessionFile: "/sessions/root.jsonl",
        });
        const nestedContext = {
          sessionManager: {
            getSessionId: () => "nested-memory-session",
            getSessionDir: () => "/sessions/tintin",
            getSessionName: () => "Review#nested00",
            getHeader: () => null,
          },
        };
        expect(
          isSubagentExecutionContext(
            nestedContext,
            "/sessions/subagents",
            posixPathFlavor,
            registry,
          ),
        ).toBe(true);

        const authorizer = new ParentAuthorizer(
          makeForwarderContext({
            hasUI: false,
            sessionId: "nested-memory-session",
          }),
          {
            forwardingDir: temp.forwardingDir,
            registry,
            logger: { review: () => {}, debug: () => {} },
          },
        );
        const decisionPromise = authorizer.authorize({
          requestId: "tool-call-identity-43",
          source: "tool_call",
          agentName: "Review",
          message: "Allow git push?",
          toolName: "bash",
          command: "git push",
        });
        const request = await waitForRequestFile(temp.location.requestsDir);
        expect(request.targetSessionId).toBe("root-ui-session");
        expect(request.requesterSessionId).toBe("nested-memory-session");
        writeFileSync(
          join(temp.location.responsesDir, `${request.id}.json`),
          JSON.stringify({
            approved: true,
            state: "approved",
            responderSessionId: "root-ui-session",
          }),
          "utf-8",
        );
        await expect(decisionPromise).resolves.toMatchObject({
          approved: true,
          state: "approved",
        });

        registry.finishTintinRun("outer000-full-run-id", "root-ui-session");
        expect(registry.has("nested-memory-session")).toBe(false);
      } finally {
        temp.cleanup();
      }
    },
  );

  test("persists the details' sessionApproval suggestion onto the forwarded request", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        {
          forwardingDir: temp.forwardingDir,
          registry,
          logger: { review: () => {}, debug: () => {} },
        },
      );

      const decisionPromise = authorizer.authorize({
        requestId: "unused-by-parent-authorizer",
        source: "tool_call",
        agentName: "Explore",
        message: "Allow git push?",
        toolName: "bash",
        command: "git push",
        sessionApproval: { surface: "bash", patterns: ["git *"] },
      });

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.sessionApproval).toEqual({
        surface: "bash",
        patterns: ["git *"],
      });

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("stamps the child-fixed access intent with requester identity onto the forwarded request", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({
          hasUI: false,
          sessionId: "child-session",
          cwd: "/worktree/issue-42",
        }),
        {
          forwardingDir: temp.forwardingDir,
          registry,
          logger: { review: () => {}, debug: () => {} },
        },
      );

      const decisionPromise = authorizer.authorize({
        requestId: "unused-by-parent-authorizer",
        source: "tool_call",
        agentName: "Explore",
        message: "Allow this path access?",
        toolName: "read",
        path: "src/foo.ts",
        accessIntent: {
          surface: "path",
          matchValues: ["/worktree/issue-42/src/foo.ts", "src/foo.ts"],
          boundaryValue: "/worktree/issue-42/src/foo.ts",
        },
      });

      const request = await waitForRequestFile(temp.location.requestsDir);
      // The display fields still ride the same request alongside the structured
      // intent (the #292/#557 non-degraded-broadcast contract must not regress).
      expect(request.source).toBe("tool_call");
      expect(request.surface).toBe("read");
      expect(request.value).toBe("src/foo.ts");
      // requesterCwd comes from ctx.cwd; principal mirrors the request's own
      // computed identity fields (sessionId, requesterAgentName).
      expect(request.accessIntent).toEqual({
        surface: "path",
        matchValues: ["/worktree/issue-42/src/foo.ts", "src/foo.ts"],
        boundaryValue: "/worktree/issue-42/src/foo.ts",
        requesterCwd: "/worktree/issue-42",
        principal: {
          sessionId: request.requesterSessionId,
          agentName: request.requesterAgentName,
        },
      });

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("omits accessIntent from the request when the details carry none", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        {
          forwardingDir: temp.forwardingDir,
          registry,
          logger: { review: () => {}, debug: () => {} },
        },
      );

      const decisionPromise = authorizer.authorize({
        requestId: "unused-by-parent-authorizer",
        source: "tool_call",
        agentName: "Explore",
        message: "Allow read?",
        toolName: "read",
      });

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.accessIntent).toBeUndefined();

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("omits sessionApproval from the request when the details carry none", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        {
          forwardingDir: temp.forwardingDir,
          registry,
          logger: { review: () => {}, debug: () => {} },
        },
      );

      const decisionPromise = authorizer.authorize({
        requestId: "unused-by-parent-authorizer",
        source: "tool_call",
        agentName: "Explore",
        message: "Allow read?",
        toolName: "read",
      });

      const request = await waitForRequestFile(temp.location.requestsDir);
      expect(request.sessionApproval).toBeUndefined();

      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: true,
          state: "approved",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );
      await decisionPromise;
    } finally {
      temp.cleanup();
    }
  });

  test("returns denied when the response marks the request denied", async () => {
    const temp = createForwardingTempDir("parent-session");
    try {
      const registry = makeSubagentRegistry("child-session", {
        parentSessionId: "parent-session",
      });
      const authorizer = new ParentAuthorizer(
        makeForwarderContext({ hasUI: false, sessionId: "child-session" }),
        {
          forwardingDir: temp.forwardingDir,
          registry,
          logger: { review: () => {}, debug: () => {} },
        },
      );

      const decisionPromise = authorizer.authorize({
        requestId: "unused-by-parent-authorizer",
        source: "tool_call",
        agentName: "Explore",
        message: "Allow read?",
        toolName: "read",
      });

      const request = await waitForRequestFile(temp.location.requestsDir);
      writeFileSync(
        join(temp.location.responsesDir, `${request.id}.json`),
        JSON.stringify({
          approved: false,
          state: "denied",
          responderSessionId: "parent-session",
        }),
        "utf-8",
      );

      // toMatchObject: see the approved-path test for why this isn't toEqual.
      await expect(decisionPromise).resolves.toMatchObject({
        approved: false,
        state: "denied",
      });
    } finally {
      temp.cleanup();
    }
  });
});
