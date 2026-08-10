import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { composeAuthorizerChain } from "#src/authority/authorizer-chain";
import type { PermissionQuery } from "#src/service";
import { getGlobalConfigPath, loadSafeAllowConfig } from "#safe/config-loader";
import { type SafeAllowConfig, withDefaults } from "#safe/config-schema";
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
    config?: SafeAllowConfig;
    disabled?: boolean;
    registry?: ModelRegistryLike;
    onCircuitBreaker?: (kind: "consecutive" | "rolling") => void;
    audit?: (event: string, details?: Record<string, unknown>) => boolean;
    evidence?: readonly unknown[];
    query?: PermissionQuery;
  } = {},
) {
  const lifecycle = new DenialLifecycle();
  const reviewer = createSafeAllowReviewer({
    getConfig: () =>
      options.config ??
      withDefaults({
        timeoutMs: options.timeoutMs ?? 100,
        maxAttempts: 3,
        disabled: options.disabled,
      }),
    getRegistry: () =>
      options.registry ?? {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
    getEvidence: () =>
      options.evidence ?? [{ role: "user", content: "Inspect the repository." }],
    getSignal: () => undefined,
    lifecycle,
    complete,
    onCircuitBreaker: options.onCircuitBreaker,
    audit: options.audit,
  });
  const terminal = { authorize: vi.fn().mockResolvedValue({ approved: false, state: "denied" }) };
  const chain = composeAuthorizerChain(
    [{ authorize: reviewer }],
    terminal,
    options.query ?? query,
  );
  return { chain, lifecycle, terminal };
}

function wrapperDetails(
  command: string,
  options: {
    agentName?: string;
    complete?: boolean;
    missing?: string[];
    pattern?: string;
    policyOrigin?: "builtin" | "global";
    policyState?: "allow" | "ask";
  } = {},
) {
  const base = makeDetails();
  const details = makeDetails({
    ...base.delegatedApproval!,
    complete: options.complete ?? true,
    missing: options.missing ?? [],
    value: command,
    action: { ...base.delegatedApproval!.action, command, input: { command } },
    accessIntent: { surface: "bash", matchValues: [command], boundaryValue: null },
    policy: {
      state: options.policyState ?? "ask",
      source: "bash",
      origin: options.policyOrigin ?? "builtin",
      matchedPattern: options.pattern ?? "<opaque-bash-wrapper>",
      reason: null,
    },
    permissionDelta: {
      from: "ask",
      to: "allow_once",
      surface: "bash",
      value: command,
    },
  });
  details.command = command;
  if (options.agentName) details.agentName = options.agentName;
  return details;
}

function permissionQuery(checkPermission: PermissionQuery["checkPermission"]): PermissionQuery {
  return { checkPermission, getToolPermission: vi.fn() };
}

function recordedPermission(state: "allow" | "ask" | "deny", reason?: string) {
  return { toolName: "bash", state, reason, source: "bash", origin: "global" } as const;
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

  it("allows a literal bash -c wrapper when every inspectable leaf has recorded allow", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails('bash -c "git status"', { agentName: "reviewer-agent" });
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).toHaveBeenCalledExactlyOnceWith(
      "bash",
      "git status",
      "reviewer-agent",
    );
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("allows a path-qualified shell with a short flag cluster when its leaf has recorded allow", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails('/bin/bash -ec "git status"');
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).toHaveBeenCalledExactlyOnceWith("bash", "git status", undefined);
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("does not decompose a wrapper whose ask came from an ordinary pattern", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails('bash -c "git status"', {
      pattern: "bash *",
      policyOrigin: "global",
    });
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("does not decompose a descriptor whose policy state is not ask", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails('bash -c "git status"', { policyState: "allow" });
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toMatchObject({
      approved: false,
      state: "denied_with_reason",
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("allows a literal eval wrapper when its inner command has recorded allow", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails('eval "git status"');
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).toHaveBeenCalledExactlyOnceWith("bash", "git status", undefined);
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("keeps multi-argument eval on the existing review path", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails('eval "git status" "&& npm publish"');
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("allows nested literal wrappers and chains only when every leaf has recorded allow", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails(`sh -c 'git status && eval "git diff --check"'`);
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission.mock.calls).toEqual([
      ["bash", "git status", undefined],
      ["bash", "git diff --check", undefined],
    ]);
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("preserves quoted separators as one deterministic leaf", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails(`bash -c 'printf "a && b"'`);
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission.mock.calls).toEqual([["bash", `printf "a && b"`, undefined]]);
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("does not treat a non-literal wrapper payload as a deterministic leaf", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails("bash -c git status");
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("keeps an unbalanced literal wrapper on the existing review path", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const details = wrapperDetails('bash -c "git status');
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("fails closed before querying a dynamic payload with an incomplete dossier", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn();
    const details = wrapperDetails('bash -c "$RUNTIME_PAYLOAD"', {
      complete: false,
      missing: ["runtime_payload"],
    });
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toMatchObject({
      approved: false,
      state: "denied_with_reason",
      denialReason: expect.stringContaining("incomplete"),
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("keeps a residual ask leaf on the existing model review path", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("ask"));
    const details = wrapperDetails('bash -c "git status"');
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
    expect(checkPermission).toHaveBeenCalledExactlyOnceWith("bash", "git status", undefined);
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("preserves a recorded deny found in a decomposed wrapper leaf", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi
      .fn()
      .mockReturnValueOnce(recordedPermission("ask"))
      .mockReturnValueOnce(recordedPermission("deny", "Publishing is forbidden."));
    const details = wrapperDetails('bash -c "git status && npm publish"');
    const { chain, terminal } = harness(complete, { query: permissionQuery(checkPermission) });

    expect(await chain.authorize(details)).toMatchObject({
      approved: false,
      state: "denied_with_reason",
      denialReason: expect.stringContaining("Publishing is forbidden."),
    });
    expect(checkPermission).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("includes tool results only when operator config opts in", async () => {
    const evidence = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "token sk-abcdefghijklmnop" }],
        isError: false,
      },
    ];
    const excludedComplete = vi.fn().mockResolvedValue(reply(decision()));
    const includedComplete = vi.fn().mockResolvedValue(reply(decision()));

    const excluded = harness(excludedComplete, {
      config: withDefaults({}),
      evidence,
    });
    const included = harness(includedComplete, {
      config: withDefaults({ includeToolResults: true }),
      evidence,
    });

    await excluded.chain.authorize(makeDetails());
    await included.chain.authorize(makeDetails());

    const excludedContext = excludedComplete.mock.calls[0]?.[1] as Context;
    const includedContext = includedComplete.mock.calls[0]?.[1] as Context;
    expect(JSON.stringify(excludedContext)).not.toContain("read result");
    expect(JSON.stringify(includedContext)).toContain(
      "read result: token [REDACTED_SECRET]",
    );
    expect(JSON.stringify(includedContext)).not.toContain(
      "sk-abcdefghijklmnop",
    );
  });

  it("writes only secret-safe selected evidence to the audit boundary", async () => {
    const audit = vi
      .fn<(event: string, details?: Record<string, unknown>) => boolean>()
      .mockReturnValue(true);
    const rawSecret = "sk-abcdefghijklmnop";
    const { chain } = harness(
      vi.fn().mockResolvedValue(reply(decision())),
      {
        audit,
        config: withDefaults({ includeToolResults: true }),
        evidence: [
          { role: "user", content: `Use token ${rawSecret}` },
          {
            role: "toolResult",
            toolName: "read",
            content: [{ type: "text", text: `result ${rawSecret}` }],
          },
        ],
      },
    );

    await chain.authorize(makeDetails());

    const routed = audit.mock.calls.find(([event]) => event === "review.routed");
    expect(routed?.[1]?.evidence).toEqual([
      expect.objectContaining({
        category: "user",
        text: "Use token [REDACTED_SECRET]",
      }),
      expect.objectContaining({
        category: "tool_result",
        text: "read result: result [REDACTED_SECRET]",
      }),
    ]);
    expect(JSON.stringify(routed)).not.toContain(rawSecret);
  });

  it("defers to the terminal when automatic review is disabled", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const { chain, terminal } = harness(complete, { disabled: true });

    expect(await chain.authorize(makeDetails())).toEqual({
      approved: false,
      state: "denied",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).toHaveBeenCalledOnce();
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

  it("loads an operator policy into the model prompt while code denies critical risk", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-reviewer-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    const policy = "ORG POLICY: deny release-key disclosure to external hosts.";
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(dirname(configPath), "guardian.md"), policy);
    writeFileSync(configPath, JSON.stringify({ policyPath: "guardian.md" }));

    try {
      const loaded = loadSafeAllowConfig({ agentDir, cwd });
      const complete = vi.fn().mockResolvedValue(
        reply(
          decision({
            riskLevel: "critical",
            verdict: "allow",
            rationale: "The model would allow this action.",
          }),
        ),
      );
      const { chain, terminal } = harness(complete, { config: loaded.config });

      const result = await chain.authorize(makeDetails());

      const context = complete.mock.calls[0]?.[1] as Context;
      expect(loaded.issues).toEqual([]);
      expect(context.systemPrompt).toContain(policy);
      expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
      expect(terminal.authorize).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
