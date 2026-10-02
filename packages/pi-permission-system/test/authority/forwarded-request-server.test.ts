import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Authorizer, AuthorizerVerdict, PathEnvelopeMode } from "#src/authority/authorizer";
import { composeAuthorizerChain } from "#src/authority/authorizer-chain";
import { encloseInDelegationEnvelope } from "#src/authority/delegation-envelope";
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

function createReviewedInbox({
  mode = "cap-allow",
  verdict = { kind: "allow" },
  policyState = "ask",
}: {
  mode?: PathEnvelopeMode;
  verdict?: AuthorizerVerdict;
  policyState?: "ask" | "deny";
} = {}) {
  const directory = createForwardingTempDir("parent-session");
  temp = directory;
  const reviewer = vi.fn<Authorizer["authorize"]>().mockResolvedValue(verdict);
  const terminal = vi.fn(async () => ({
    approved: false,
    state: "denied" as const,
  }));
  const recordSessionApproval = vi.fn();
  const resolve = vi.fn(() => makeCheckResult({ state: policyState }));
  const chain = composeAuthorizerChain(
    [{ authorize: encloseInDelegationEnvelope(reviewer, mode) }],
    { authorize: terminal },
    {
      checkPermission: vi.fn(() => makeCheckResult({ state: "ask" })),
      resolveTarget: vi.fn(() => null),
      getToolPermission: vi.fn(() => "ask" as const),
    },
  );
  const server = new ForwardedRequestServer(
    makeServerDeps({
      forwardingDir: directory.forwardingDir,
      policy: { resolve },
      escalator: { escalate: (details) => chain.authorize(details) },
      recorder: { recordSessionApproval },
    }),
  );
  const processInbox = () => server.processInbox(
    makeForwarderContext({
      hasUI: true,
      sessionId: "parent-session",
      cwd: "/different/parent-checkout",
    }),
  );
  return { directory, reviewer, terminal, resolve, recordSessionApproval, processInbox };
}

describe("processInbox — delegated grant safety", () => {
  test.each(["cap-allow", "honor-reviewer"] as const)(
    "uses authoritative path facts rather than bash display under %s",
    async (mode) => {
      const harness = createReviewedInbox({ mode });
      harness.directory.writeRequest({
        id: "sensitive-path",
        surface: "bash",
        value: "git status",
        accessIntent: makeForwardedAccessIntent({
          surface: "path",
          matchValues: ["/child/.env", ".env"],
          boundaryValue: "/child/.env",
        }),
      });
      await harness.processInbox();
      const allowed = mode === "honor-reviewer";
      expect(readResponse(harness.directory, "sensitive-path")).toMatchObject({
        approved: allowed,
        state: allowed ? "approved" : "denied",
      });
      expect(harness.reviewer).toHaveBeenCalledTimes(1);
      expect(harness.terminal).toHaveBeenCalledTimes(allowed ? 0 : 1);
      expect(harness.recordSessionApproval).not.toHaveBeenCalled();
    },
  );

  describe.each(["cap-allow", "honor-reviewer"] as const)("%s", (mode) => {
    test.each(["missing", "malformed"] as const)(
      "%s wire facts cannot gain an automatic reviewer grant",
      async (facts) => {
        const harness = createReviewedInbox({ mode });
        const request = harness.directory.writeRequest({
          id: "invalid-facts",
          surface: "bash",
          value: "git status",
        });
        if (facts === "malformed") {
          writeFileSync(
            join(harness.directory.location.requestsDir, `${request.id}.json`),
            JSON.stringify({
              ...request,
              accessIntent: { ...makeForwardedAccessIntent(), matchValues: [42] },
            }),
          );
        }
        await harness.processInbox();
        expect(harness.resolve).not.toHaveBeenCalled();
        expect(harness.reviewer).toHaveBeenCalledTimes(1);
        expect(harness.terminal).toHaveBeenCalledTimes(1);
        expect(readResponse(harness.directory, request.id)).toMatchObject({
          approved: false,
          state: "denied",
        });
        expect(harness.recordSessionApproval).not.toHaveBeenCalled();
      },
    );
  });

  test("recorded policy deny bypasses an allowing reviewer and terminal", async () => {
    const harness = createReviewedInbox({ policyState: "deny" });
    harness.directory.writeRequest({
      id: "policy-deny",
      accessIntent: makeForwardedAccessIntent(),
    });
    await harness.processInbox();
    expect(harness.reviewer).not.toHaveBeenCalled();
    expect(harness.terminal).not.toHaveBeenCalled();
    expect(readResponse(harness.directory, "policy-deny")).toMatchObject({
      approved: false,
      state: "denied",
    });
    expect(harness.recordSessionApproval).not.toHaveBeenCalled();
  });

  test.each(["deny", "defer"] as const)(
    "preserves the reviewer's %s outcome",
    async (kind) => {
      const harness = createReviewedInbox({ verdict: { kind } });
      harness.directory.writeRequest({
        id: "reviewer-outcome",
        accessIntent: makeForwardedAccessIntent(),
      });
      await harness.processInbox();
      expect(harness.reviewer).toHaveBeenCalledTimes(1);
      expect(harness.terminal).toHaveBeenCalledTimes(kind === "defer" ? 1 : 0);
      expect(readResponse(harness.directory, "reviewer-outcome")).toMatchObject({
        approved: false,
        state: "denied",
      });
      expect(harness.recordSessionApproval).not.toHaveBeenCalled();
    },
  );
});

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

  test.each(["bash", "external_directory"] as const)(
    "forwards authoritative %s facts for a nonpersistent reviewer grant",
    async (surface) => {
      const harness = createReviewedInbox();
      const accessIntent = makeForwardedAccessIntent({
        surface,
        matchValues: surface === "bash"
          ? ["git status"]
          : ["/child/artifact.txt", "artifact.txt"],
        boundaryValue: surface === "bash" ? null : "/child/artifact.txt",
      });
      for (const id of ["first-grant", "second-grant"]) {
        harness.directory.writeRequest({
          id,
          surface: "path", // Display fields cannot replace child-fixed facts.
          value: "/different/parent-checkout/display-only",
          accessIntent,
          sessionApproval: { surface, patterns: ["*"] },
        });
      }
      await harness.processInbox();
      for (const id of ["first-grant", "second-grant"]) {
        expect(readResponse(harness.directory, id)).toMatchObject({
          approved: true,
          state: "approved",
        });
      }
      expect(harness.resolve).toHaveBeenCalledWith(accessIntent);
      expect(harness.reviewer).toHaveBeenCalledTimes(2);
      expect(harness.reviewer).toHaveBeenCalledWith(
        expect.objectContaining({ accessIntent }),
        expect.anything(),
      );
      expect(harness.terminal).not.toHaveBeenCalled();
      expect(harness.recordSessionApproval).not.toHaveBeenCalled();
    },
  );

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
      accessIntent,
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

  test("hands the child host version and batch provenance to the reviewer without adding them to forwarding display", async () => {
    temp = createForwardingTempDir("parent-session");
    temp.writeRequest({
      id: "req-batch",
      source: "tool_call",
      surface: "bash",
      value: "git status",
      accessIntent: makeForwardedAccessIntent({ matchValues: ["git status"] }),
      batchProvenance: "single",
      hostVersion: "0.100.0",
    });
    const escalate = vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" });

    const server = new ForwardedRequestServer(
      makeServerDeps({
        forwardingDir: temp.forwardingDir,
        policy: { resolve: vi.fn(() => makeCheckResult({ state: "ask" })) },
        escalator: { escalate },
      }),
    );
    await server.processInbox(
      makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
    );

    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardedBatchProvenance: "single",
        forwardedHostVersion: "0.100.0",
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      }),
    );
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
