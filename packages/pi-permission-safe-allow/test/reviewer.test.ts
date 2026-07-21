import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { composeAuthorizerChain } from "#src/authority/authorizer-chain";
import type { PermissionQuery } from "#src/service";
import { withDefaults } from "#safe/config-schema";
import { DenialLifecycle } from "#safe/denial-lifecycle";
import type { CompleteFn, ModelRegistryLike } from "#safe/model-review";
import { createSafeAllowReviewer } from "#safe/safe-allow-reviewer";
import { makeDetails } from "#test/fixtures";

const model = {} as Model<any>;
const query = {
  checkPermission: vi.fn(),
  getToolPermission: vi.fn(),
} as unknown as PermissionQuery;

function reply(decision: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(decision) }],
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    riskLevel: "low",
    userAuthorization: "medium",
    verdict: "allow",
    rationale: "The exact repository inspection is authorized and low risk.",
    scope: "narrow",
    absoluteDeny: false,
    ...overrides,
  };
}

function harness(
  complete: CompleteFn,
  options: {
    timeoutMs?: number;
    registry?: ModelRegistryLike;
    onCircuitBreaker?: (kind: "consecutive" | "rolling") => void;
    audit?: (event: string, details?: Record<string, unknown>) => boolean;
  } = {},
) {
  const lifecycle = new DenialLifecycle();
  const reviewer = createSafeAllowReviewer({
    getConfig: () => withDefaults({ timeoutMs: options.timeoutMs ?? 100, maxAttempts: 3 }),
    getRegistry: () =>
      options.registry ?? {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
    getEvidence: () => [{ role: "user", content: "Inspect the repository." }],
    getSignal: () => undefined,
    lifecycle,
    complete,
    onCircuitBreaker: options.onCircuitBreaker,
    audit: options.audit,
  });
  const terminal = { authorize: vi.fn().mockResolvedValue({ approved: false, state: "denied" }) };
  const chain = composeAuthorizerChain([{ authorize: reviewer }], terminal, query);
  return { chain, lifecycle, terminal };
}

describe("registered delegated reviewer seam", () => {
  beforeEach(() => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-permission-safe-allow-tests";
  });

  it("approves an eligible bash ask without reaching the human terminal", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const { chain, terminal } = harness(complete);

    const result = await chain.authorize(makeDetails());

    expect(result).toEqual({ approved: true, state: "approved" });
    expect(terminal.authorize).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("fails closed after bounded malformed-output retries", async () => {
    const complete = vi.fn().mockResolvedValue(
      reply({ verdict: "defer" }),
    );
    const { chain, terminal } = harness(complete);

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      state: "denied_with_reason",
      denialReason: expect.stringContaining("failed (parse)"),
    });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("returns explicit rationale and non-circumvention instruction", async () => {
    const { chain, terminal } = harness(
      vi.fn().mockResolvedValue(
        reply(decision({ riskLevel: "critical", verdict: "allow", rationale: "Would disclose credentials." })),
      ),
    );

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      denialReason: expect.stringContaining("Would disclose credentials."),
    });
    expect(result.denialReason).toContain("Do not pursue the same outcome");
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("adds an exact one-shot user override to the retry dossier without bypassing review", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        reply(
          decision({
            riskLevel: "high",
            userAuthorization: "unknown",
            verdict: "deny",
            rationale: "Needs explicit authorization.",
          }),
        ),
      )
      .mockResolvedValueOnce(reply(decision({ userAuthorization: "high" })));
    const { chain, lifecycle } = harness(complete);

    await chain.authorize(makeDetails());
    const denial = lifecycle.recentDenials()[0];
    expect(lifecycle.authorizeOneRetry(denial.denialId)).toBe(true);
    const result = await chain.authorize(makeDetails());

    expect(result).toEqual({ approved: true, state: "approved" });
    const secondContext = complete.mock.calls[1][1] as Context;
    expect(JSON.stringify(secondContext)).toContain("explicitlyAuthorizedByUser");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("surfaces timeout separately and never executes or falls through", async () => {
    const complete: CompleteFn = vi.fn((_model, _context, options) =>
      new Promise<AssistantMessage>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
    );
    const { chain, terminal } = harness(complete, { timeoutMs: 5 });

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      denialReason: expect.stringContaining("timed out"),
    });
    expect(result.denialReason).toContain("not evidence that the action is unsafe");
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("fails closed when reviewer authentication cannot be resolved", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const { chain, terminal } = harness(complete, {
      registry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "not logged in" }),
      },
    });

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      denialReason: expect.stringContaining("failed (auth)"),
    });
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("reviews an ask-state Skill while policy-allowed trusted Skills bypass upstream", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const { chain } = harness(complete);
    const details = makeDetails({
      ...makeDetails().delegatedApproval!,
      surface: "skill",
      value: "implement",
      exactActionId: "skill-implement",
      action: {
        ...makeDetails().delegatedApproval!.action,
        kind: "skill",
        command: null,
        toolName: null,
      },
      permissionDelta: {
        from: "ask",
        to: "allow_once",
        surface: "skill",
        value: "implement",
      },
    });
    details.source = "skill_input";
    details.skillName = "implement";

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(complete).toHaveBeenCalledOnce();

    expect(await chain.authorize(makeDetails())).toEqual({ approved: true, state: "approved" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the final allow audit event cannot be written", async () => {
    const audit = vi
      .fn<(event: string, details?: Record<string, unknown>) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const { chain, terminal } = harness(
      vi.fn().mockResolvedValue(reply(decision())),
      { audit },
    );

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      denialReason: expect.stringContaining("failed (audit)"),
    });
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("trips the consecutive-denial circuit breaker on the third denial", async () => {
    const onCircuitBreaker = vi.fn();
    const { chain } = harness(
      vi
        .fn()
        .mockResolvedValue(
          reply(
            decision({
              riskLevel: "high",
              userAuthorization: "unknown",
              verdict: "deny",
              rationale: "Denied.",
            }),
          ),
        ),
      { onCircuitBreaker },
    );
    await chain.authorize(makeDetails());
    await chain.authorize(makeDetails());
    await chain.authorize(makeDetails());
    expect(onCircuitBreaker).toHaveBeenCalledWith("consecutive");
  });
});
