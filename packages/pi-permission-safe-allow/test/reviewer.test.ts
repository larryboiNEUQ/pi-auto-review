import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildDelegatedApprovalFacts } from "#src/authority/delegated-approval-facts";
import { composeAuthorizerChain } from "#src/authority/authorizer-chain";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import { encloseInDelegationEnvelope } from "#src/authority/delegation-envelope";
import { describeToolGate } from "#src/handlers/gates/tool";
import { posixPathFlavor } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path-normalizer";
import { PermissionManager } from "#src/permission-manager";
import { PermissionResolver } from "#src/permission-resolver";
import { LocalPermissionsService } from "#src/permissions-service";
import type { PermissionQuery } from "#src/service";
import { SessionRules } from "#src/session-rules";
import { resolveToolPreviewLimits, ToolPreviewFormatter } from "#src/tool-preview-formatter";
import { getGlobalConfigPath, loadSafeAllowConfig } from "#safe/config-loader";
import { type SafeAllowConfig, withDefaults } from "#safe/config-schema";
import { DenialLifecycle } from "#safe/denial-lifecycle";
import type { CompleteFn, ModelRegistryLike } from "#safe/model-review";
import { createSafeAllowReviewer } from "#safe/safe-allow-reviewer";
import { runReadOnlyProbes } from "#safe/read-only-probes";
import { makeDetails, makeSkillReadDetails } from "#test/fixtures";

const model = {} as Model<any>;
const query = {
  checkPermission: vi.fn(),
  getToolPermission: vi.fn(),
  resolveTarget: vi.fn(),
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
    terminalDecision?: PermissionPromptDecision;
  } = {},
) {
  const lifecycle = new DenialLifecycle();
  const config =
    options.config ??
    withDefaults({
      timeoutMs: options.timeoutMs ?? 100,
      maxAttempts: 3,
      disabled: options.disabled,
    });
  const reviewer = createSafeAllowReviewer({
    getConfig: () => config,
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
  const terminal = {
    authorize: vi.fn().mockResolvedValue(
      options.terminalDecision ?? { approved: false, state: "denied" },
    ),
  };
  const chain = composeAuthorizerChain(
    [{
      authorize: encloseInDelegationEnvelope(
        reviewer,
        config.pathEnvelopeMode,
      ),
    }],
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

function permissionQuery(
  capability: PermissionQuery["checkPermission"],
): PermissionQuery {
  return {
    checkPermission: capability,
    getToolPermission: vi.fn(),
    resolveTarget: capability as unknown as PermissionQuery["resolveTarget"],
  };
}

function recordedPermission(state: "allow" | "ask" | "deny", reason?: string) {
  return { toolName: "bash", state, reason, source: "bash", origin: "global" } as const;
}

function eligibleMcpProbeDetails(
  check: ReturnType<PermissionQuery["checkPermission"]> = {
    toolName: "mcp",
    state: "ask",
    source: "mcp",
    origin: "global",
    target: "mcp_call",
    matchedPattern: "mcp_call",
  },
  options: { argumentPayload?: unknown; inputPayload?: unknown } = {},
) {
  const details = makeDetails();
  const input = Object.hasOwn(options, "inputPayload")
    ? options.inputPayload
    : {
        server: "github",
        tool: "get_issue",
        annotations: { readOnlyHint: true },
        connectedAccount: { id: "account-1" },
        arguments: Object.hasOwn(options, "argumentPayload")
          ? options.argumentPayload
          : { number: 17 },
      };
  details.message = "Read issue metadata?";
  details.toolName = "mcp";
  details.command = undefined;
  details.target = check.target;
  details.accessIntent = {
    surface: "mcp",
    matchValues: ["github_get_issue", "github:get_issue", "mcp_call"],
    boundaryValue: null,
  };
  details.delegatedApproval = buildDelegatedApprovalFacts({
    details,
    input,
    check,
    surface: "mcp",
    value: check.target ?? "mcp",
  });
  return details;
}

function productionMcpDetails(check: ReturnType<PermissionQuery["checkPermission"]>) {
  const input = {
    server: "github",
    tool: "get_issue",
    annotations: { readOnlyHint: true },
    connectedAccount: { id: "account-1" },
    arguments: { number: 17 },
  };
  const descriptor = describeToolGate(
    {
      toolName: "mcp",
      agentName: null,
      input,
      toolCallId: "mcp-call-17",
      cwd: "/repo",
    },
    check,
    new ToolPreviewFormatter(resolveToolPreviewLimits({})),
  );
  const details = { requestId: "mcp-call-17", ...descriptor.promptDetails };
  return {
    ...details,
    delegatedApproval: buildDelegatedApprovalFacts({
      details,
      input: descriptor.input,
      check,
      surface: descriptor.surface,
      value: descriptor.decision.value,
    }),
  };
}

function realMcpPermissionQuery(
  mcpRules: Record<string, "ask"> = { mcp_call: "ask" },
): { query: PermissionQuery; cleanup: () => void } {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-safe-allow-mcp-query-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    globalConfigPath,
    JSON.stringify({
      permission: {
        mcp: mcpRules,
      },
    }),
    "utf8",
  );
  const manager = new PermissionManager({ globalConfigPath, agentsDir });
  const resolver = new PermissionResolver(manager, new SessionRules());
  const registerOnly = { register: () => () => undefined };
  const service = new LocalPermissionsService(
    resolver,
    { getPathNormalizer: () => new PathNormalizer(posixPathFlavor, baseDir) },
    registerOnly,
    registerOnly,
    registerOnly,
  );
  return {
    query: service,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

describe("registered delegated reviewer seam", () => {
  beforeEach(() => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-permission-safe-allow-tests";
  });

  it.each([
    ["~/.agents/skills/herdr/SKILL.md", "low"],
    ["~/.agents/skills/herdr/SKILL.md", "medium"],
    ["/home/operator/.agents/skills/herdr/SKILL.md", "medium"],
  ] as const)(
    "reviews an installed skill-file read against the current grant in a long implement session (%s, %s)",
    async (skillPath, riskLevel) => {
      const earlierNarrative =
        "Earlier session goal: implement Issue #50 as a large feature across many packages.";
      const grant = "Implement Issue #50. Read installed skills when needed.";
      const complete = vi.fn().mockResolvedValue(
        reply(decision({ riskLevel, scope: "narrow" })),
      );
      const { chain, terminal } = harness(complete, {
        evidence: [
          { role: "user", content: earlierNarrative },
          { role: "assistant", content: earlierNarrative },
          { role: "user", content: grant },
        ],
      });

      const result = await chain.authorize(makeSkillReadDetails(skillPath));

      expect(result).toEqual({ approved: true, state: "approved" });
      expect(terminal.authorize).not.toHaveBeenCalled();
      const prompt = String((complete.mock.calls[0]?.[1] as Context).messages[0]?.content);
      expect(prompt).toContain(grant);
      expect(prompt).toContain(skillPath);
      expect(prompt).not.toContain("Earlier session goal");
    },
  );

  it("escalates a non-critical Guardian high-risk floor to the terminal authority", async () => {
    const complete = vi.fn().mockResolvedValue(
      reply(
        decision({
          riskLevel: "high",
          userAuthorization: "low",
          verdict: "allow",
          rationale: "Model treated a wide payload as authorized.",
          scope: "broad",
        }),
      ),
    );
    const { chain, terminal } = harness(complete, {
      terminalDecision: { approved: true, state: "approved" },
    });

    expect(await chain.authorize(makeDetails())).toEqual({
      approved: true,
      state: "approved",
    });
    expect(terminal.authorize).toHaveBeenCalledOnce();
  });

  it("leaves the final decision for a broad high-risk outcome to the terminal", async () => {
    const complete = vi.fn().mockResolvedValue(
      reply(
        decision({
          riskLevel: "high",
          userAuthorization: "high",
          verdict: "allow",
          rationale: "Local skill file read is authorized.",
          scope: "broad",
        }),
      ),
    );
    const { chain, terminal } = harness(complete);

    expect(
      await chain.authorize(
        makeSkillReadDetails("~/.agents/skills/herdr/SKILL.md"),
      ),
    ).toEqual({ approved: false, state: "denied" });
    expect(terminal.authorize).toHaveBeenCalledOnce();
  });

  it("approves an eligible bash ask without reaching the human terminal", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const { chain, terminal } = harness(complete);

    const result = await chain.authorize(makeDetails());

    expect(result).toEqual({ approved: true, state: "approved" });
    expect(terminal.authorize).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("defers an ordinary reviewer denial to the same pending terminal decision", async () => {
    const complete = vi.fn().mockResolvedValue(
      reply(decision({ verdict: "deny", rationale: "Ask the operator." })),
    );
    const audit = vi.fn().mockReturnValue(true);
    const onCircuitBreaker = vi.fn();
    const { chain, lifecycle, terminal } = harness(complete, {
      audit,
      onCircuitBreaker,
      terminalDecision: { approved: true, state: "approved" },
    });
    const details = makeDetails();

    expect(await chain.authorize(details)).toEqual({
      approved: true,
      state: "approved",
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).toHaveBeenCalledExactlyOnceWith(details);
    expect(lifecycle.recentDenials()).toEqual([]);
    expect(onCircuitBreaker).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "review.decision",
      expect.objectContaining({
        verdict: "deny",
        escalated: true,
        escalation: "terminal_authority",
      }),
    );
  });

  it.each([
    ["No", { approved: false, state: "denied" as const }],
    [
      "No, provide reason",
      {
        approved: false,
        state: "denied_with_reason" as const,
        denialReason: "Use a read-only alternative.",
      },
    ],
    [
      "cancel",
      {
        approved: false,
        state: "denied_with_reason" as const,
        denialReason: "Permission prompt cancelled.",
      },
    ],
  ])("preserves the terminal %s decision after escalation", async (_choice, terminalDecision) => {
    const complete = vi.fn().mockResolvedValue(
      reply(decision({ verdict: "deny", rationale: "Ask the operator." })),
    );
    const { chain, terminal } = harness(complete, { terminalDecision });

    expect(await chain.authorize(makeDetails())).toEqual(terminalDecision);
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).toHaveBeenCalledOnce();
  });

  it("reaches the fail-closed headless terminal after an ordinary denial", async () => {
    const terminalDecision = {
      approved: false,
      state: "denied_with_reason" as const,
      denialReason: "Permission confirmation is unavailable in this session.",
      confirmationUnavailable: true as const,
    };
    const { chain, terminal } = harness(
      vi.fn().mockResolvedValue(reply(decision({ verdict: "deny" }))),
      { terminalDecision },
    );

    expect(await chain.authorize(makeDetails())).toEqual(terminalDecision);
    expect(terminal.authorize).toHaveBeenCalledOnce();
  });

  it.each([
    ["subagent-only", "approved_for_session" as const],
    ["whole-serving-session", "approved_for_serving_session" as const],
  ])("preserves forwarded %s terminal scope", async (_scope, state) => {
    const { chain, terminal } = harness(
      vi.fn().mockResolvedValue(reply(decision({ verdict: "deny" }))),
      { terminalDecision: { approved: true, state } },
    );
    const details = makeDetails();
    details.forwarding = {
      requesterAgentName: "Explore",
      requesterSessionId: "child-session",
    };
    details.sessionApproval = { surface: "bash", patterns: ["git *"] };

    expect(await chain.authorize(details)).toEqual({ approved: true, state });
    expect(terminal.authorize).toHaveBeenCalledExactlyOnceWith(details);
  });

  it("fails closed instead of prompting when the escalation audit cannot be written", async () => {
    const audit = vi.fn().mockImplementation((event: string) => event !== "review.decision");
    const { chain, terminal } = harness(
      vi.fn().mockResolvedValue(
        reply(decision({ verdict: "deny", rationale: "Ask the operator." })),
      ),
      { audit, terminalDecision: { approved: true, state: "approved" } },
    );

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      state: "denied_with_reason",
      denialReason: expect.stringContaining("failed (audit)"),
    });
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("defaults sensitive path allows to the human terminal", async () => {
    expect(withDefaults({}).pathEnvelopeMode).toBe("cap-allow");
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const { chain, terminal } = harness(complete);
    const details = makeDetails();
    details.accessIntent = {
      surface: "path",
      matchValues: ["/work/repo/.env"],
      boundaryValue: "/work/repo/.env",
    };

    const result = await chain.authorize(details);

    expect(result).toEqual({ approved: false, state: "denied" });
    expect(terminal.authorize).toHaveBeenCalledOnce();
  });

  it("honors a reviewer allow on a sensitive path after operator opt-out", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ pathEnvelopeMode: "honor-reviewer" }),
    });
    const details = makeDetails();
    details.accessIntent = {
      surface: "path",
      matchValues: ["/work/repo/.env"],
      boundaryValue: "/work/repo/.env",
    };

    const result = await chain.authorize(details);

    expect(result).toEqual({ approved: true, state: "approved" });
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("enriches a production MCP fallback target through the public Authorizer seam", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const realQuery = realMcpPermissionQuery();
    const initialCheck = realQuery.query.checkPermission("mcp", "github:get_issue");
    expect(initialCheck).toMatchObject({
      state: "ask",
      target: "mcp_call",
      matchedPattern: "mcp_call",
    });
    const details = productionMcpDetails(initialCheck);
    expect(details.target).toBe("mcp_call");
    expect(details.delegatedApproval).toMatchObject({
      complete: false,
      missing: ["action.target"],
      action: { target: null },
    });
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: realQuery.query,
    });

    try {
      expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
      const context = complete.mock.calls[0]?.[1] as Context;
      const dossierPrompt = String(context.messages[0]?.content);
      expect(dossierPrompt).toContain('"category":"probe"');
      expect(dossierPrompt).toContain('"capability":"permission.target.resolve"');
      expect(dossierPrompt).toContain('"target":"github_get_issue"');
      expect(dossierPrompt).not.toContain('"target":"mcp_status"');
      expect(complete).toHaveBeenCalledOnce();
      expect(terminal.authorize).not.toHaveBeenCalled();
    } finally {
      realQuery.cleanup();
    }
  });

  it("uses only the authoritative target returned by read-only resolution", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const resolveTarget = vi.fn().mockReturnValue("authoritative_issue_reader");
    const checkPermission = vi.fn();
    const details = eligibleMcpProbeDetails();
    const initialActionId = details.delegatedApproval!.exactActionId;
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: {
        checkPermission,
        getToolPermission: vi.fn(),
        resolveTarget,
      } as PermissionQuery,
    });

    expect(await chain.authorize(details)).toEqual({
      approved: true,
      state: "approved",
    });
    const prompt = String((complete.mock.calls[0]?.[1] as Context).messages[0]?.content);
    expect(prompt).toContain('"capability":"permission.target.resolve"');
    expect(prompt).toContain('"target":"authoritative_issue_reader"');
    expect(prompt).not.toContain('"target":"github_get_issue"');
    expect(prompt).not.toContain(`"exactActionId":"${initialActionId}"`);
    expect(resolveTarget).toHaveBeenCalledExactlyOnceWith(
      "mcp",
      "github:get_issue",
      undefined,
    );
    expect(checkPermission).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("does not probe an already-resolved production MCP target", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const realQuery = realMcpPermissionQuery({ github_get_issue: "ask" });
    const initialCheck = realQuery.query.checkPermission("mcp", "github:get_issue");
    expect(initialCheck.target).toBe("github_get_issue");
    const details = productionMcpDetails(initialCheck);
    expect(details.delegatedApproval).toMatchObject({
      complete: true,
      missing: [],
      action: { target: "github_get_issue" },
    });
    const checkPermission = vi.fn((
      ...args: Parameters<PermissionQuery["checkPermission"]>
    ) => realQuery.query.checkPermission(...args));
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(checkPermission),
    });

    try {
      expect(await chain.authorize(details)).toEqual({ approved: true, state: "approved" });
      expect(checkPermission).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledOnce();
      expect(terminal.authorize).not.toHaveBeenCalled();
    } finally {
      realQuery.cleanup();
    }
  });

  it("fails closed by the probe deadline when the bounded lookup never settles", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const neverSettles = vi.fn().mockReturnValue(new Promise(() => undefined));
    const details = eligibleMcpProbeDetails();
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true, probeTimeoutMs: 5 }),
      query: permissionQuery(
        neverSettles as unknown as PermissionQuery["checkPermission"],
      ),
    });

    const result = await Promise.race([
      chain.authorize(details),
      new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 100)),
    ]);

    expect(result).not.toBe("test-timeout");
    expect(result).toMatchObject({
      approved: false,
      state: "denied_with_reason",
      decisionSource: "reviewer_failure",
      failureCode: "probe",
    });
    expect(neverSettles).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("denies without probing when the read-only hop budget is exhausted", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn();
    const details = eligibleMcpProbeDetails();
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true, probeMaxHops: 0 }),
      query: permissionQuery(checkPermission),
    });

    const result = await chain.authorize(details);

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toMatchObject({
      decisionSource: "reviewer_failure",
      failureCode: "probe",
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it.each([Number.MIN_VALUE, 0.5, 1, Number.MAX_VALUE])(
    "treats positive runtime hop budget %s as one canonical lookup",
    async (maxHops) => {
      const resolveTarget = vi.fn().mockReturnValue("github_get_issue");
      const outcome = await runReadOnlyProbes({
        details: eligibleMcpProbeDetails(),
        query: {
          checkPermission: vi.fn(),
          getToolPermission: vi.fn(),
          resolveTarget,
        } as PermissionQuery,
        maxHops,
        timeoutMs: 100,
      });

      expect(outcome).toMatchObject({ kind: "completed", hops: 1 });
      expect(resolveTarget).toHaveBeenCalledExactlyOnceWith(
        "mcp",
        "github:get_issue",
        undefined,
      );
    },
  );

  it.each([
    [0.5, 1],
    [60_000, 5_000],
  ])(
    "enforces runtime probe timeout %s as %sms at the direct probe seam",
    async (timeoutMs, expectedTimeoutMs) => {
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const outcome = await runReadOnlyProbes({
          details: eligibleMcpProbeDetails(),
          query: {
            checkPermission: vi.fn(),
            getToolPermission: vi.fn(),
            resolveTarget: vi.fn().mockReturnValue("github_get_issue"),
          } as PermissionQuery,
          maxHops: 1,
          timeoutMs,
        });

        expect(outcome).toMatchObject({ kind: "completed", hops: 1 });
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), expectedTimeoutMs);
      } finally {
        timeoutSpy.mockRestore();
      }
    },
  );

  it("denies an ineligible untrusted MCP payload without probing", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn();
    const base = makeDetails();
    const details = makeDetails({
      ...base.delegatedApproval!,
      surface: "mcp",
      value: "github:get_issue",
      complete: false,
      missing: ["action.target"],
      redactions: ["action.input.token"],
      action: {
        ...base.delegatedApproval!.action,
        kind: "mcp",
        toolName: "mcp",
        command: null,
        target: null,
        input: { server: "github", tool: "get_issue", token: "[REDACTED_SECRET]" },
        mcp: {
          server: "github",
          tool: "get_issue",
          annotations: { readOnlyHint: true },
          connectedAccount: { id: "account-1" },
          arguments: { token: "[REDACTED_SECRET]" },
        },
      },
      policy: {
        state: "ask",
        source: "mcp",
        origin: "global",
        matchedPattern: "github:*",
        reason: null,
      },
    });
    details.toolName = "mcp";
    details.target = undefined;
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(checkPermission),
    });

    const result = await chain.authorize(details);

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toMatchObject({
      decisionSource: "reviewer_failure",
      failureCode: "probe",
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", [17]],
    ["a primitive", "17"],
    ["a custom prototype", Object.create({ number: 17 })],
  ])("denies %s MCP arguments without probing", async (_label, argumentPayload) => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn();
    const details = eligibleMcpProbeDetails(undefined, { argumentPayload });
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(checkPermission),
    });

    const result = await chain.authorize(details);

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toMatchObject({
      decisionSource: "reviewer_failure",
      failureCode: "probe",
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("does not invoke an enumerable MCP argument getter or start a probe", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const getter = vi.fn(() => "secret");
    const argumentPayload: Record<string, unknown> = {};
    Object.defineProperty(argumentPayload, "token", {
      enumerable: true,
      get: getter,
    });
    const resolveTarget = vi.fn();
    const details = eligibleMcpProbeDetails(undefined, { argumentPayload });
    expect(details.delegatedApproval).toMatchObject({
      complete: false,
      missing: ["action.input", "action.mcp.arguments"],
      action: { mcp: { arguments: {} } },
    });
    expect(getter).not.toHaveBeenCalled();
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: {
        checkPermission: vi.fn(),
        getToolPermission: vi.fn(),
        resolveTarget,
      } as PermissionQuery,
    });

    const result = await chain.authorize(details);

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(getter).not.toHaveBeenCalled();
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("rejects unsafe data anywhere in the MCP payload without probing", async () => {
    const accessorPayload: Record<string, unknown> = {
      server: "github",
      tool: "get_issue",
      annotations: { readOnlyHint: true },
      arguments: { number: 17 },
    };
    const getter = vi.fn(() => "not inert");
    Object.defineProperty(accessorPayload, "unrelated", {
      enumerable: true,
      get: getter,
    });
    const cyclicPayload: Record<string, unknown> = {
      server: "github",
      tool: "get_issue",
      annotations: { readOnlyHint: true },
      arguments: { number: 17 },
    };
    cyclicPayload.self = cyclicPayload;
    const nestedPrototypePayload = {
      server: "github",
      tool: "get_issue",
      annotations: Object.assign(Object.create({ inherited: true }), { readOnlyHint: true }),
      arguments: { number: 17 },
    };
    const customPrototypePayload = Object.assign(Object.create({ inherited: true }), {
      server: "github",
      tool: "get_issue",
      annotations: { readOnlyHint: true },
      arguments: { number: 17 },
    });

    for (const inputPayload of [
      accessorPayload,
      cyclicPayload,
      nestedPrototypePayload,
      customPrototypePayload,
    ]) {
      const resolveTarget = vi.fn();
      const details = eligibleMcpProbeDetails(undefined, { inputPayload });
      expect(details.delegatedApproval).toMatchObject({
        complete: false,
        missing: expect.arrayContaining(["action.input"]),
      });
      const { chain } = harness(vi.fn(), {
        config: withDefaults({ readOnlyProbes: true }),
        query: {
          checkPermission: vi.fn(),
          getToolPermission: vi.fn(),
          resolveTarget,
        } as PermissionQuery,
      });

      expect(await chain.authorize(details)).toMatchObject({
        approved: false,
        state: "denied_with_reason",
      });
      expect(resolveTarget).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("fails closed when the read-only permission query rejects", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockRejectedValue(new Error("query unavailable"));
    const details = eligibleMcpProbeDetails();
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(
        checkPermission as unknown as PermissionQuery["checkPermission"],
      ),
    });

    const result = await chain.authorize(details);

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toMatchObject({
      decisionSource: "reviewer_failure",
      failureCode: "probe",
    });
    expect(result.denialReason).not.toContain("query unavailable");
    expect(checkPermission).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("fails closed when canonical target resolution throws synchronously", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const resolveTarget = vi.fn(() => {
      throw new Error("synchronous query failure");
    });
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: {
        checkPermission: vi.fn(),
        getToolPermission: vi.fn(),
        resolveTarget,
      } as PermissionQuery,
    });

    const result = await chain.authorize(eligibleMcpProbeDetails());

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toMatchObject({
      decisionSource: "reviewer_failure",
      failureCode: "probe",
    });
    expect(result.denialReason).not.toContain("synchronous query failure");
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("fails closed when canonical target resolution returns null", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const resolveTarget = vi.fn().mockReturnValue(null);
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(
        resolveTarget as unknown as PermissionQuery["checkPermission"],
      ),
    });

    const result = await chain.authorize(eligibleMcpProbeDetails());

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toMatchObject({ decisionSource: "reviewer_failure", failureCode: "probe" });
    expect(resolveTarget).toHaveBeenCalledExactlyOnceWith(
      "mcp",
      "github:get_issue",
      undefined,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("exposes no mutating capability to the read-only probe path", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const resolveTarget = vi.fn().mockReturnValue("github_get_issue");
    const mutate = vi.fn();
    const probeQuery = {
      checkPermission: vi.fn(),
      getToolPermission: vi.fn(),
      resolveTarget,
      mutate,
    } as unknown as PermissionQuery;
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: probeQuery,
    });

    expect(await chain.authorize(eligibleMcpProbeDetails())).toEqual({
      approved: true,
      state: "approved",
    });
    expect(resolveTarget).toHaveBeenCalledExactlyOnceWith(
      "mcp",
      "github:get_issue",
      undefined,
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("labels canonical target evidence as secret-safe", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const resolveTarget = vi.fn().mockReturnValue("github_get_issue");
    const audit = vi.fn().mockReturnValue(true);
    const { chain } = harness(complete, {
      audit,
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(
        resolveTarget as unknown as PermissionQuery["checkPermission"],
      ),
    });

    expect(await chain.authorize(eligibleMcpProbeDetails())).toEqual({
      approved: true,
      state: "approved",
    });
    const prompt = String((complete.mock.calls[0]?.[1] as Context).messages[0]?.content);
    expect(prompt).toContain('"secretSafe":true');
    expect(prompt).toContain('"target":"github_get_issue"');
    const decided = audit.mock.calls.find(([event]) => event === "review.decision")?.[1];
    expect(decided).toMatchObject({
      policyVersion: "guardian-outcomes-v1",
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      probeUsed: true,
    });
  });

  it("fails closed when canonical target resolution returns secret-bearing data", async () => {
    const rawSecret = "prefix_sk-abcdefghijklmnop";
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const audit = vi.fn().mockReturnValue(true);
    const { chain, terminal } = harness(complete, {
      audit,
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(
        vi.fn().mockReturnValue(rawSecret) as unknown as PermissionQuery["checkPermission"],
      ),
    });

    const result = await chain.authorize(eligibleMcpProbeDetails());

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(rawSecret);
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("fails closed before review when probe evidence cannot be audited", async () => {
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue("github_get_issue");
    const audit = vi.fn().mockImplementation((event: string) => event !== "probe.completed");
    const { chain, terminal } = harness(complete, {
      audit,
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(checkPermission),
    });

    const result = await chain.authorize(eligibleMcpProbeDetails());

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toHaveProperty(
      "denialReason",
      expect.stringContaining("failed (audit)"),
    );
    expect(audit).toHaveBeenCalledWith("probe.completed", expect.any(Object));
    expect(checkPermission).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["critical risk", { riskLevel: "critical" }],
    ["an absolute deny", { absoluteDeny: true }],
  ])("reapplies the Guardian %s floor after probe enrichment", async (_label, overrides) => {
    const complete = vi.fn().mockResolvedValue(
      reply(decision({ ...overrides, verdict: "allow", rationale: "Model attempted allow." })),
    );
    const checkPermission = vi.fn().mockReturnValue("github_get_issue");
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(checkPermission),
    });

    const result = await chain.authorize(eligibleMcpProbeDetails());

    expect(result).toMatchObject({ approved: false, state: "denied_with_reason" });
    expect(result).toHaveProperty("denialReason", expect.stringContaining("Model attempted allow."));
    expect(checkPermission).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it("escalates a non-critical high-risk floor after probe enrichment", async () => {
    const complete = vi.fn().mockResolvedValue(
      reply(decision({
        riskLevel: "high",
        userAuthorization: "low",
        verdict: "allow",
        rationale: "Model treated weak authorization as sufficient.",
        scope: "narrow",
      })),
    );
    const checkPermission = vi.fn().mockReturnValue("github_get_issue");
    const { chain, terminal } = harness(complete, {
      config: withDefaults({ readOnlyProbes: true }),
      query: permissionQuery(checkPermission),
    });

    expect(await chain.authorize(eligibleMcpProbeDetails())).toEqual({
      approved: false,
      state: "denied",
    });
    expect(checkPermission).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminal.authorize).toHaveBeenCalledOnce();
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

  it("audits a deterministic opaque-wrapper allow with policy identity and outcome", async () => {
    const audit = vi.fn().mockReturnValue(true);
    const complete = vi.fn().mockResolvedValue(reply(decision()));
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("allow"));
    const { chain } = harness(complete, { audit, query: permissionQuery(checkPermission) });

    await chain.authorize(wrapperDetails('bash -c "git status"'));

    expect(audit).toHaveBeenCalledWith("review.decision", expect.objectContaining({
      policyVersion: "guardian-outcomes-v1",
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      probeUsed: false,
      attempts: 0,
      riskLevel: null,
      userAuthorization: null,
      verdict: "allow",
    }));
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
      decisionSource: "reviewer_failure",
      failureCode: "evidence",
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

  it("audits a deterministic opaque-wrapper deny with policy identity and outcome", async () => {
    const audit = vi.fn().mockReturnValue(true);
    const checkPermission = vi.fn().mockReturnValue(recordedPermission("deny", "Blocked."));
    const { chain } = harness(vi.fn(), { audit, query: permissionQuery(checkPermission) });

    await chain.authorize(wrapperDetails('bash -c "npm publish"'));

    expect(audit).toHaveBeenCalledWith("review.decision", expect.objectContaining({
      policyVersion: "guardian-outcomes-v1",
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      probeUsed: false,
      attempts: 0,
      riskLevel: null,
      userAuthorization: null,
      verdict: "deny",
    }));
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

  it("records the effective policy identity and review outcome in audit JSONL fields", async () => {
    const audit = vi
      .fn<(event: string, details?: Record<string, unknown>) => boolean>()
      .mockReturnValue(true);
    const { chain } = harness(
      vi.fn().mockResolvedValue(reply(decision())),
      {
        audit,
        config: withDefaults({ policy: "ORG POLICY: exact audited rules." }),
      },
    );

    await chain.authorize(makeDetails());

    const routed = audit.mock.calls.find(([event]) => event === "review.routed")?.[1];
    const decided = audit.mock.calls.find(([event]) => event === "review.decision")?.[1];
    expect(routed).toMatchObject({
      policyVersion: "guardian-outcomes-v1",
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      probeUsed: false,
    });
    expect(decided).toMatchObject({
      policyVersion: "guardian-outcomes-v1",
      policyHash: routed?.policyHash,
      probeUsed: false,
      attempts: 1,
      riskLevel: "low",
      userAuthorization: "medium",
      verdict: "allow",
    });
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
      decisionSource: "reviewer_failure",
      failureCode: "parse",
      denialReason: expect.stringContaining("failed (parse)"),
    });
    expect(result.denialReason).toContain("action was not executed");
    expect(result.denialReason).not.toContain("malformed structured output");
    expect(complete).toHaveBeenCalledTimes(3);
    expect(terminal.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["transport", "transport"],
    ["model", "model"],
  ] as const)(
    "classifies %s failures without exposing provider details",
    async (failureKind, expectedCode) => {
      const complete: CompleteFn =
        failureKind === "transport"
          ? vi
              .fn()
              .mockRejectedValue(
                new Error("Authorization: Bearer provider-secret"),
              )
          : vi.fn().mockResolvedValue({
              ...reply(decision()),
              stopReason: "error",
              errorMessage: "Authorization: Bearer provider-secret",
            } as AssistantMessage);
      const { chain, terminal } = harness(complete);

      const result = await chain.authorize(makeDetails());

      expect(result).toMatchObject({
        approved: false,
        state: "denied_with_reason",
        decisionSource: "reviewer_failure",
        failureCode: expectedCode,
      });
      expect(result.denialReason).not.toContain("provider-secret");
      expect(terminal.authorize).not.toHaveBeenCalled();
    },
  );

  it("labels a valid critical reviewer deny as a reviewer decision", async () => {
    const { chain, terminal } = harness(
      vi.fn().mockResolvedValue(
        reply(
          decision({
            riskLevel: "critical",
            verdict: "deny",
            rationale: "The action would disclose a credential.",
          }),
        ),
      ),
    );

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      state: "denied_with_reason",
      decisionSource: "reviewer",
    });
    expect(result).not.toHaveProperty("failureCode");
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
            absoluteDeny: true,
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
        getApiKeyAndHeaders: async () => ({
          ok: false,
          error: "Authorization: Bearer top-secret-provider-detail",
        }),
      },
    });

    const result = await chain.authorize(makeDetails());

    expect(result).toMatchObject({
      approved: false,
      decisionSource: "reviewer_failure",
      failureCode: "auth",
      denialReason: expect.stringContaining("failed (auth)"),
    });
    expect(result.denialReason).not.toContain("top-secret-provider-detail");
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

  it("ordinary escalation resets the consecutive hard-deny streak without entering denial history", async () => {
    const onCircuitBreaker = vi.fn();
    const critical = reply(
      decision({
        riskLevel: "critical",
        userAuthorization: "unknown",
        verdict: "deny",
        rationale: "Hard floor.",
        absoluteDeny: false,
      }),
    );
    const ordinary = reply(
      decision({
        riskLevel: "low",
        userAuthorization: "medium",
        verdict: "deny",
        rationale: "Ask the operator.",
      }),
    );
    const complete = vi
      .fn()
      .mockResolvedValueOnce(critical)
      .mockResolvedValueOnce(ordinary)
      .mockResolvedValueOnce(critical)
      .mockResolvedValueOnce(critical)
      .mockResolvedValueOnce(critical);
    const { chain, lifecycle, terminal } = harness(complete, {
      onCircuitBreaker,
      terminalDecision: { approved: true, state: "approved" },
    });

    await chain.authorize(makeDetails()); // hard #1
    await chain.authorize(makeDetails()); // ordinary escalate → recordNonDenial
    expect(lifecycle.recentDenials()).toHaveLength(1);
    expect(onCircuitBreaker).not.toHaveBeenCalled();

    await chain.authorize(makeDetails()); // hard after reset (#1)
    await chain.authorize(makeDetails()); // hard (#2)
    expect(onCircuitBreaker).not.toHaveBeenCalled();
    expect(lifecycle.recentDenials()).toHaveLength(3);

    await chain.authorize(makeDetails()); // hard (#3) trips consecutive
    expect(onCircuitBreaker).toHaveBeenCalledExactlyOnceWith("consecutive");
    expect(terminal.authorize).toHaveBeenCalledOnce();
  });

  it("trips the consecutive-denial circuit breaker on the third denial", async () => {
    const onCircuitBreaker = vi.fn();
    const { chain } = harness(
      vi
        .fn()
        .mockResolvedValue(
          reply(
            decision({
              riskLevel: "critical",
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
