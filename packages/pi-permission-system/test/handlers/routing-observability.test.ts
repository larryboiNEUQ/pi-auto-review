import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  getDecisionEvents,
  makeCheckResult,
  makeCtx,
  makeHandler,
  makeToolCallEvent,
} from "#test/helpers/handler-fixtures";

describe("tool-call routing observability", () => {
  it("marks a hard deny and does not enter the authorizer chain", async () => {
    const { handler, events, logger, prompter } = makeHandler({
      tools: ["read"],
    });

    const outcome = await handler.handleToolCall(
      makeToolCallEvent("read", {
        input: { path: join(tmpdir(), ".env") },
      }),
      makeCtx(),
    );

    expect(outcome).toMatchObject({ action: "block" });
    expect(prompter.escalate).not.toHaveBeenCalled();
    expect(getDecisionEvents(events)).toContainEqual(
      expect.objectContaining({
        result: "deny",
        routingSource: "hard_deny",
      }),
    );
    expect(logger.review).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({ routingSource: "hard_deny" }),
    );
  });

  it("marks an ordinary policy deny and does not enter the authorizer chain", async () => {
    const { handler, events, logger, prompter } = makeHandler({
      tools: ["read"],
      session: {
        checkPermission: vi.fn().mockReturnValue(
          makeCheckResult({
            state: "deny",
            origin: "project",
            matchedPattern: "*.private",
          }),
        ),
      },
    });

    const outcome = await handler.handleToolCall(
      makeToolCallEvent("read", {
        input: { path: join("/test/project", "notes.private") },
      }),
      makeCtx(),
    );

    expect(outcome).toMatchObject({ action: "block" });
    expect(prompter.escalate).not.toHaveBeenCalled();
    expect(getDecisionEvents(events)).toContainEqual(
      expect.objectContaining({
        result: "deny",
        routingSource: "policy_deny",
      }),
    );
    expect(logger.review).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({ routingSource: "policy_deny" }),
    );
  });

  it("marks an ask escalation and enters the authorizer chain", async () => {
    const { handler, events, prompter } = makeHandler({
      tools: ["read"],
      session: {
        checkPermission: vi
          .fn()
          .mockReturnValue(makeCheckResult({ state: "ask" })),
      },
      prompter: {
        escalate: vi.fn().mockResolvedValue({
          approved: true,
          state: "approved",
        }),
      },
    });

    const outcome = await handler.handleToolCall(
      makeToolCallEvent("read", {
        input: { path: join("/test/project", "README.md") },
      }),
      makeCtx(),
    );

    expect(outcome).toEqual({ action: "allow" });
    expect(prompter.escalate).toHaveBeenCalledOnce();
    expect(getDecisionEvents(events)).toContainEqual(
      expect.objectContaining({
        result: "allow",
        routingSource: "ask_escalation",
      }),
    );
  });

  it("marks a deterministic allow as a non-authorizer path", async () => {
    const { handler, events, prompter } = makeHandler({
      tools: ["read"],
      session: {
        checkPermission: vi.fn().mockReturnValue(
          makeCheckResult({
            state: "allow",
            origin: "global",
            matchedPattern: "*",
          }),
        ),
      },
    });

    const outcome = await handler.handleToolCall(
      makeToolCallEvent("read", {
        input: { path: join("/test/project", "README.md") },
      }),
      makeCtx(),
    );

    expect(outcome).toEqual({ action: "allow" });
    expect(prompter.escalate).not.toHaveBeenCalled();
    expect(getDecisionEvents(events)).toContainEqual(
      expect.objectContaining({
        result: "allow",
        routingSource: "local_allow",
      }),
    );
  });
});
