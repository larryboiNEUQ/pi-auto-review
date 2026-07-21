import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ForwardedRequestServer } from "#src/authority/forwarded-request-server";
import type { ForwardedPermissionResponse } from "#src/authority/permission-forwarding";
import {
  createForwardingTempDir,
  type ForwardingTempDir,
  makeForwardedAccessIntent,
  makeForwarderContext,
  makeServerDeps,
  makeSubagentRegistry,
} from "#test/helpers/forwarding-fixtures";
import { makeCheckResult } from "#test/helpers/handler-fixtures";

let temp: ForwardingTempDir | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
  vi.unstubAllEnvs();
});

function readResponse(
  dir: ForwardingTempDir,
  requestId: string,
): ForwardedPermissionResponse {
  const raw = readFileSync(
    join(dir.location.responsesDir, `${requestId}.json`),
    "utf-8",
  );
  return JSON.parse(raw) as ForwardedPermissionResponse;
}

describe("processInbox — recorded-authority resolution", () => {
  test("auto-approves and writes an approved response when the serving policy allows", async () => {
    temp = createForwardingTempDir("parent-session");
    const accessIntent = makeForwardedAccessIntent({
      matchValues: ["git status"],
    });
    temp.writeRequest({
      id: "req-allow",
      source: "tool_call",
      surface: "bash",
      value: "git status",
      accessIntent,
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "allow" }));
    const escalate = vi.fn();
    const logger = { review: vi.fn(), debug: vi.fn() };

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        logger,
        policy: { resolve },
        escalator: { escalate },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(resolve).toHaveBeenCalledWith(accessIntent);
    expect(escalate).not.toHaveBeenCalled();
    expect(readResponse(temp, "req-allow")).toMatchObject({
      approved: true,
      state: "approved",
    });
    expect(logger.review).toHaveBeenCalledWith(
      "forwarded_permission.auto_approved",
      expect.objectContaining({ requestId: "req-allow" }),
    );
  });

  test("auto-denies and writes a denied response when the serving policy denies", async () => {
    temp = createForwardingTempDir("parent-session");
    const accessIntent = makeForwardedAccessIntent({
      matchValues: ["rm -rf /"],
    });
    temp.writeRequest({
      id: "req-deny",
      source: "tool_call",
      surface: "bash",
      value: "rm -rf /",
      accessIntent,
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "deny" }));
    const escalate = vi.fn();
    const logger = { review: vi.fn(), debug: vi.fn() };

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        logger,
        policy: { resolve },
        escalator: { escalate },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(resolve).toHaveBeenCalledWith(accessIntent);
    expect(escalate).not.toHaveBeenCalled();
    expect(readResponse(temp, "req-deny")).toMatchObject({
      approved: false,
      state: "denied",
    });
    expect(logger.review).toHaveBeenCalledWith(
      "forwarded_permission.auto_denied",
      expect.objectContaining({ requestId: "req-deny" }),
    );
  });

  test("escalates an ask through the AskEscalator with the forwarded provenance details", async () => {
    temp = createForwardingTempDir("parent-session");
    const accessIntent = makeForwardedAccessIntent({
      matchValues: ["git push"],
    });
    temp.writeRequest({
      id: "req-ask",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      accessIntent,
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "ask" }));
    const escalate = vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" });

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve },
        escalator: { escalate },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(resolve).toHaveBeenCalledWith(accessIntent);
    expect(escalate).toHaveBeenCalledWith({
      requestId: "req-ask",
      source: "tool_call",
      agentName: "Explore",
      message:
        "Subagent 'Explore' requested permission.\nSession ID: child-session\n\nAllow git push?",
      surface: "bash",
      value: "git push",
      forwarding: {
        requesterAgentName: "Explore",
        requesterSessionId: "child-session",
      },
    });
    expect(readResponse(temp, "req-ask")).toMatchObject({
      approved: true,
      state: "approved",
    });
  });

  test("floors a request with no fields at all (fully legacy) to escalation without consulting the policy", async () => {
    temp = createForwardingTempDir("parent-session");
    // Legacy / version-skew request: no source/surface/value/accessIntent.
    temp.writeRequest({ id: "req-legacy" });

    const resolve = vi.fn(() => makeCheckResult({ state: "allow" }));
    const escalate = vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" });

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve },
        escalator: { escalate },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-legacy",
        source: "tool_call",
        surface: null,
        value: null,
      }),
    );
  });

  test("floors a version-skew request with display fields but no accessIntent to escalation without consulting the policy", async () => {
    temp = createForwardingTempDir("parent-session");
    // An older child populated the display fields but never computed the
    // structured intent (ADR 0008 §4: accessIntent is the sole resolution
    // path — a request missing it floors to `ask`, never a silent grant).
    temp.writeRequest({
      id: "req-skew",
      source: "tool_call",
      surface: "bash",
      value: "git push",
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "allow" }));
    const escalate = vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" });

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve },
        escalator: { escalate },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-skew",
        surface: "bash",
        value: "git push",
      }),
    );
  });

  test("denies when the escalator rejects", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({
      id: "req-throw",
      surface: "bash",
      value: "git push",
      accessIntent: makeForwardedAccessIntent({ matchValues: ["git push"] }),
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "ask" }));
    const escalate = vi.fn().mockRejectedValue(new Error("ui gone"));
    const logger = { review: vi.fn(), debug: vi.fn() };

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        logger,
        policy: { resolve },
        escalator: { escalate },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(readResponse(temp, "req-throw")).toMatchObject({
      approved: false,
      state: "denied",
    });
    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.error",
      expect.objectContaining({
        message: expect.stringContaining("escalate"),
      }),
    );
  });
});

describe("processInbox — grant-scope selection", () => {
  test("records a whole-session grant into the serving recorder and translates the response to a plain approve", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({
      id: "req-whole",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      accessIntent: makeForwardedAccessIntent({ matchValues: ["git push"] }),
      sessionApproval: { surface: "bash", patterns: ["git *"] },
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "ask" }));
    const escalate = vi.fn().mockResolvedValue({
      approved: true,
      state: "approved_for_serving_session",
    });
    const recordSessionApproval = vi.fn();

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve },
        escalator: { escalate },
        recorder: { recordSessionApproval },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(recordSessionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "bash", patterns: ["git *"] }),
    );
    // Translated: the child receives a plain approve and records nothing.
    expect(readResponse(temp, "req-whole")).toMatchObject({
      approved: true,
      state: "approved",
    });
  });

  test("offers the request's sessionApproval to the escalated dialog details", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({
      id: "req-scope-details",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      accessIntent: makeForwardedAccessIntent({ matchValues: ["git push"] }),
      sessionApproval: { surface: "bash", patterns: ["git *"] },
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "ask" }));
    const escalate = vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" });

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve },
        escalator: { escalate },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionApproval: { surface: "bash", patterns: ["git *"] },
      }),
    );
  });

  test("passes a subagent-only grant through untouched without recording on the serving node", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({
      id: "req-subagent",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      accessIntent: makeForwardedAccessIntent({ matchValues: ["git push"] }),
      sessionApproval: { surface: "bash", patterns: ["git *"] },
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "ask" }));
    const escalate = vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved_for_session" });
    const recordSessionApproval = vi.fn();

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve },
        escalator: { escalate },
        recorder: { recordSessionApproval },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(recordSessionApproval).not.toHaveBeenCalled();
    // Passed through: the child records its own pattern (today's behavior).
    expect(readResponse(temp, "req-subagent")).toMatchObject({
      approved: true,
      state: "approved_for_session",
    });
  });
});

describe("processInbox — one-hop canary", () => {
  test("warns when the requester is a registered subagent whose parent is not this serving session", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({ id: "req-hop", surface: "bash", value: "git push" });

    const logger = { review: vi.fn(), debug: vi.fn() };
    const registry = makeSubagentRegistry("child-session", {
      parentSessionId: "some-other-session",
    });

    const server = new ForwardedRequestServer(
      makeServerDeps({ forwardingDir: temp.forwardingDir, logger, registry }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.warning",
      expect.objectContaining({
        message: expect.stringContaining("one-hop"),
      }),
    );
  });

  test("stays silent for an unregistered (external file-based) requester", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({ id: "req-ext", surface: "bash", value: "git push" });

    const logger = { review: vi.fn(), debug: vi.fn() };
    const registry = makeSubagentRegistry("child-session"); // no entry

    const server = new ForwardedRequestServer(
      makeServerDeps({ forwardingDir: temp.forwardingDir, logger, registry }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(logger.review).not.toHaveBeenCalledWith(
      "permission_forwarding.warning",
      expect.anything(),
    );
  });

  test("stays silent for a registered one-hop child whose parent is this serving session", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({ id: "req-ok", surface: "bash", value: "git push" });

    const logger = { review: vi.fn(), debug: vi.fn() };
    const registry = makeSubagentRegistry("child-session", {
      parentSessionId: "parent-session",
    });

    const server = new ForwardedRequestServer(
      makeServerDeps({ forwardingDir: temp.forwardingDir, logger, registry }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(logger.review).not.toHaveBeenCalledWith(
      "permission_forwarding.warning",
      expect.anything(),
    );
  });
});

describe("processInbox — inbox mechanics", () => {
  test("recreates a missing responses/ directory and still writes the response", async () => {
    // Simulate the race: requests/ exists with a pending file, but
    // responses/ was removed by a concurrent cleanup pass (#398).
    temp = createForwardingTempDir("parent-session", {
      createResponsesDir: false,
    });
    temp.writeRequest({
      id: "req-race",
      surface: "bash",
      value: "cat x",
      accessIntent: makeForwardedAccessIntent({ matchValues: ["cat x"] }),
    });

    const logger = { review: vi.fn(), debug: vi.fn() };
    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        logger,
        policy: { resolve: vi.fn(() => makeCheckResult({ state: "allow" })) },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(logger.review).not.toHaveBeenCalledWith(
      "permission_forwarding.error",
      expect.anything(),
    );
    expect(readResponse(temp, "req-race")).toMatchObject({
      approved: true,
      state: "approved",
    });
  });

  test("ignores and deletes a request targeting a different session", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({
      id: "req-mismatch",
      targetSessionId: "other-session",
      surface: "bash",
      value: "git push",
      accessIntent: makeForwardedAccessIntent({ matchValues: ["git push"] }),
    });

    const resolve = vi.fn(() => makeCheckResult({ state: "allow" }));
    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve },
      }),
    );

    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(resolve).not.toHaveBeenCalled();
  });
});
