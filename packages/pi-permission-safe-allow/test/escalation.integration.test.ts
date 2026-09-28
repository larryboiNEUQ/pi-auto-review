import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthorizerRegistry } from "#src/authority/authorizer-registry";
import { AuthorizerSelection } from "#src/authority/authorizer-selection";
import { ForwardedRequestServer } from "#src/authority/forwarded-request-server";
import {
  createPermissionForwardingLocation,
  type ForwardedPermissionRequest,
} from "#src/authority/permission-forwarding";
import { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import { PermissionPrompter } from "#src/authority/permission-prompter";
import { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import { GateRunner } from "#src/handlers/gates/runner";
import { describeToolGate } from "#src/handlers/gates/tool";
import { PermissionManager } from "#src/permission-manager";
import { PermissionResolver } from "#src/permission-resolver";
import type { PermissionQuery } from "#src/service";
import { SessionRules } from "#src/session-rules";
import { resolveToolPreviewLimits, ToolPreviewFormatter } from "#src/tool-preview-formatter";
import { SAFE_ALLOW_EXTENSION_ID, withDefaults } from "#safe/config-schema";
import { DenialLifecycle } from "#safe/denial-lifecycle";
import { logSafeAllow } from "#safe/log";
import { JEV_QUESTIONS, type EvaluateJevFn } from "#safe/jev-evaluation";
import type { CompleteFn, ModelRegistryLike } from "#safe/model-review";
import { createSafeAllowReviewer } from "#safe/safe-allow-reviewer";

const model = {} as Model<any>;
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function reviewerReply(overrides: Record<string, unknown> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{
      type: "text",
      text: JSON.stringify({
        riskLevel: "low",
        userAuthorization: "medium",
        verdict: "deny",
        rationale: "The operator should make the final decision.",
        scope: "narrow",
        absoluteDeny: false,
        ...overrides,
      }),
    }],
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

interface HarnessOptions {
  evaluate?: EvaluateJevFn;
  jev?: boolean;
  apiKey?: () => Promise<string | undefined>;
  signal?: AbortSignal;
  failAudit?: boolean;
  failFinalAudit?: boolean;
  maxAttempts?: number;
  noProviderAuth?: boolean;
  hasUI?: boolean;
  isSubagent?: boolean;
  parentSessionId?: string;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  realSafeAudit?: boolean;
}

function createGateHarness(
  complete: CompleteFn,
  options: HarnessOptions = {},
) {
  const root = mkdtempSync(join(tmpdir(), "safe-allow-escalation-"));
  roots.push(root);
  const globalConfigPath = join(root, "pi-permissions.jsonc");
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, JSON.stringify({
    permission: {
      bash: {
        "git *": "ask",
        "npm *": "ask",
        "denied *": "deny",
      },
    },
  }));

  const sessionRules = new SessionRules();
  const manager = new PermissionManager({ globalConfigPath, agentsDir });
  const resolver = new PermissionResolver(manager, sessionRules);
  const config = withDefaults({ timeoutMs: 100, maxAttempts: options.maxAttempts ?? 1, ...(options.jev ? { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" } : {}) });
  const lifecycle = new DenialLifecycle();
  const agentDir = join(root, "agent");
  if (options.realSafeAudit) vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const safeAudit = options.realSafeAudit
    ? vi.fn(logSafeAllow)
    : vi.fn((event: string, _details?: Record<string, unknown>) => !options.failAudit && !(options.failFinalAudit && event === "review.decision"));
  const reviewer = createSafeAllowReviewer({
    getConfig: () => config,
    getRegistry: () => ({
      find: () => options.jev ? undefined : model,
      getApiKeyForProvider: options.noProviderAuth ? undefined : options.apiKey ?? (async () => "synthetic-key"),
      getApiKeyAndHeaders: async () => ({ ok: true }),
    }) as ModelRegistryLike,
    getEvidence: () => [{ role: "user", content: "Inspect this repository." }],
    getSignal: () => options.signal,
    lifecycle,
    complete: options.jev ? async () => { throw new Error("Jev must not invoke chat completion"); } : complete,
    evaluate: options.evaluate ?? (options.jev ? async (request) => {
      const reply = await complete(model, { messages: [] }, { signal: request.signal });
      if (reply.stopReason === "error") throw new Error("synthetic service failure");
      const decision = JSON.parse((reply.content[0] as { text: string }).text);
      return jevAnswers(decision);
    } : undefined),
    audit: safeAudit,
  });

  const permissionAudit = vi.fn();
  const permissionEvents = { emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) };
  const ui = {
    select: vi.fn(options.select ?? (async () => "No")),
    input: vi.fn(options.input ?? (async () => undefined)),
    custom: vi.fn(),
  };
  const prompter = new PermissionPrompter({ logger: { review: permissionAudit } });
  const authorizerRegistry = new AuthorizerRegistry();
  authorizerRegistry.register("safe-allow", reviewer);
  const subagentRegistry = new SubagentSessionRegistry();
  if (options.parentSessionId) {
    subagentRegistry.register("child-session", {
      parentSessionId: options.parentSessionId,
    });
  }
  const forwardingDir = join(root, "forwarding");
  const selection = new AuthorizerSelection({
    detection: { isSubagent: vi.fn(() => options.isSubagent ?? false) },
    events: permissionEvents,
    getPromptPreferences: () => ({ doublePressToConfirm: true }),
    requestPermissionDecision,
    forwardingDir,
    registry: subagentRegistry,
    logger: { review: permissionAudit, debug: vi.fn() },
    prompter,
    getPermissionQuery: () => resolver as unknown as PermissionQuery,
    authorizerRegistry,
    getAuthorizerChain: () => ["safe-allow"],
  });
  selection.activate({
    cwd: root,
    hasUI: options.hasUI ?? true,
    mode: "rpc",
    ui,
    sessionManager: {
      getSessionId: () => "child-session",
      getSessionDir: () => root,
      getEntries: () => [],
    },
  } as unknown as ExtensionContext);

  const reporter = { writeReviewLog: vi.fn(), emitDecision: vi.fn() };
  const runner = new GateRunner(resolver, sessionRules, selection, reporter);
  const formatter = new ToolPreviewFormatter(resolveToolPreviewLimits({}));

  async function run(command: string, requestId: string) {
    const input = { command };
    const check = resolver.checkPermission("bash", input);
    const descriptor = describeToolGate({
      toolName: "bash",
      agentName: null,
      input,
      toolCallId: requestId,
      cwd: root,
    }, check, formatter);
    return runner.run(descriptor, null, requestId);
  }

  return {
    root,
    agentDir,
    forwardingDir,
    run,
    complete,
    lifecycle,
    permissionAudit,
    permissionEvents,
    safeAudit,
    sessionRules,
    ui,
  };
}

const makeGateHarness = createGateHarness;
function jevAnswers(decision: Record<string, unknown> = {}) {
  const values = { riskLevel: "low", userAuthorization: "medium", verdict: "allow", scope: "narrow", absoluteDeny: false, ...decision };
  return { answers: Object.fromEntries(Object.keys(JEV_QUESTIONS).map((id) => [id, {
    type: "choice", choice: id === "absoluteDeny" ? (values.absoluteDeny ? "yes" : "no") : id === "explanationCategory" ? "policy_permitted" : values[id as keyof typeof values],
  }])) };
}

async function waitForForwardedRequest(
  forwardingDir: string,
  parentSessionId: string,
): Promise<ForwardedPermissionRequest> {
  const location = createPermissionForwardingLocation(forwardingDir, parentSessionId);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try {
      files = readdirSync(location.requestsDir).filter((file) => file.endsWith(".json"));
    } catch {
      files = [];
    }
    if (files[0]) {
      return JSON.parse(
        readFileSync(join(location.requestsDir, files[0]), "utf8"),
      ) as ForwardedPermissionRequest;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for forwarded permission request");
}

describe("ordinary Safe-Allow denial escalation through the real gate", () => {
  it("continues the same pending request after native one-time approval", async () => {
    const complete = vi.fn().mockResolvedValue(reviewerReply());
    const harness = makeGateHarness(complete, {
      select: async (_title, options) => {
        expect(options).toEqual([
          "Yes",
          expect.stringContaining("for this session"),
          "No",
          "No, provide reason",
        ]);
        return "Yes";
      },
    });

    expect(await harness.run("git status", "call-1")).toEqual({ action: "allow" });
    expect(complete).toHaveBeenCalledOnce();
    expect(harness.ui.select).toHaveBeenCalledOnce();
    expect(harness.lifecycle.recentDenials()).toEqual([]);
    expect(harness.safeAudit).toHaveBeenCalledWith(
      "review.decision",
      expect.objectContaining({
        verdict: "deny",
        escalated: true,
        escalation: "terminal_authority",
      }),
    );
    expect(harness.permissionAudit).toHaveBeenCalledWith(
      "permission_request.approved",
      expect.objectContaining({ requestId: "call-1", resolution: "approved" }),
    );
  });

  it("records only the suggested session pattern and bypasses model and UI on a match", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(reviewerReply())
      .mockResolvedValueOnce(reviewerReply());
    let promptCount = 0;
    const harness = makeGateHarness(complete, {
      select: async (_title, options) => {
        promptCount += 1;
        return promptCount === 1 ? options[1] : "No";
      },
    });

    expect(await harness.run("git status", "call-1")).toEqual({ action: "allow" });
    expect(harness.sessionRules.getRuleset()).toEqual([
      expect.objectContaining({
        surface: "bash",
        pattern: "git status*",
        origin: "session",
      }),
    ]);
    expect(await harness.run("git status --short", "call-2")).toEqual({ action: "allow" });
    expect(complete).toHaveBeenCalledOnce();
    expect(harness.ui.select).toHaveBeenCalledOnce();

    expect(await harness.run("npm publish", "call-3")).toMatchObject({ action: "block" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(harness.ui.select).toHaveBeenCalledTimes(2);
  });

  it("stops the pending request when the native prompt selects No", async () => {
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reviewerReply()),
      { select: async () => "No" },
    );

    expect(await harness.run("git status", "call-no")).toMatchObject({ action: "block" });
    expect(harness.ui.select).toHaveBeenCalledOnce();
    expect(harness.ui.input).not.toHaveBeenCalled();
    expect(harness.permissionAudit).toHaveBeenCalledWith(
      "permission_request.denied",
      expect.objectContaining({ requestId: "call-no", resolution: "denied" }),
    );
  });

  it("feeds a native denial reason back while stopping the pending request", async () => {
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reviewerReply()),
      {
        select: async () => "No, provide reason",
        input: async () => "Use the read-only mirror instead.",
      },
    );

    const result = await harness.run("git status", "call-reason");
    expect(result).toMatchObject({ action: "block" });
    expect(result).toHaveProperty(
      "reason",
      expect.stringContaining("Use the read-only mirror instead."),
    );
    expect(harness.ui.input).toHaveBeenCalledOnce();
    expect(harness.permissionAudit).toHaveBeenCalledWith(
      "permission_request.denied",
      expect.objectContaining({
        requestId: "call-reason",
        resolution: "denied_with_reason",
        denialReason: "Use the read-only mirror instead.",
      }),
    );
  });

  it("treats native prompt cancellation as a denial", async () => {
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reviewerReply()),
      { select: async () => undefined },
    );

    expect(await harness.run("git status", "call-cancel")).toMatchObject({ action: "block" });
    expect(harness.ui.select).toHaveBeenCalledOnce();
    expect(harness.permissionAudit).toHaveBeenCalledWith(
      "permission_request.denied",
      expect.objectContaining({ requestId: "call-cancel", resolution: "denied" }),
    );
  });

  it.each([
    ["approved_for_session", true],
    ["approved_for_serving_session", false],
  ] as const)(
    "forwards escalation through the parent server and preserves the %s scope decision",
    async (state, childRecordsSessionRule) => {
      const harness = makeGateHarness(
        vi.fn().mockResolvedValue(reviewerReply()),
        {
          hasUI: false,
          isSubagent: true,
          parentSessionId: "parent-session",
        },
      );
      const parentSessionRules = new SessionRules();
      const parentEscalate = vi.fn().mockResolvedValue({ approved: true, state });
      const parentServer = new ForwardedRequestServer({
        forwardingDir: harness.forwardingDir,
        logger: { review: vi.fn(), debug: vi.fn() },
        policy: {
          resolve: () => ({
            state: "ask",
            toolName: "bash",
            source: "bash",
            origin: "builtin",
          }),
        },
        escalator: { escalate: parentEscalate },
        recorder: parentSessionRules,
      });

      const pending = harness.run("git status", `call-${state}`);
      const request = await waitForForwardedRequest(
        harness.forwardingDir,
        "parent-session",
      );
      expect(request).toMatchObject({
        requesterSessionId: "child-session",
        targetSessionId: "parent-session",
        sessionApproval: { surface: "bash", patterns: ["git status*"] },
      });
      await parentServer.processInbox({
        hasUI: true,
        cwd: "/parent",
        ui: { select: vi.fn(), input: vi.fn() },
        sessionManager: {
          getSessionId: () => "parent-session",
          getSessionDir: () => "/parent",
          getEntries: () => [],
        },
      });

      await expect(pending).resolves.toEqual({ action: "allow" });
      expect(harness.ui.select).not.toHaveBeenCalled();
      expect(parentEscalate).toHaveBeenCalledOnce();
      expect(harness.sessionRules.getRuleset().length > 0).toBe(childRecordsSessionRule);
      expect(parentSessionRules.getRuleset().length > 0).toBe(!childRecordsSessionRule);
    },
  );

  it("selects the denying terminal for headless escalation without invoking UI", async () => {
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reviewerReply()),
      { hasUI: false },
    );

    const result = await harness.run("git status", "call-headless");
    expect(result).toMatchObject({
      action: "block",
      reason: expect.stringContaining("no interactive UI is available"),
    });
    expect(harness.ui.select).not.toHaveBeenCalled();
    expect(harness.ui.input).not.toHaveBeenCalled();
    expect(harness.permissionAudit).toHaveBeenCalledWith(
      "permission_request.denied",
      expect.objectContaining({
        requestId: "call-headless",
        resolution: "confirmation_unavailable",
      }),
    );
  });

  it("keeps reviewer escalation and human provenance separate and secret-redacted", async () => {
    const rawSecret = "sk-abcdefghijklmnop";
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reviewerReply({
        rationale: `The token ${rawSecret} requires operator approval.`,
      })),
      { select: async () => "Yes", realSafeAudit: true },
    );

    expect(await harness.run("git status", "call-secret")).toEqual({ action: "allow" });

    const logFile = join(
      harness.agentDir,
      "extensions",
      SAFE_ALLOW_EXTENSION_ID,
      "logs",
      "safe-allow.jsonl",
    );
    const events = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const reviewerDecision = events.find((event) => event.event === "review.decision");
    expect(reviewerDecision).toMatchObject({
      extension: SAFE_ALLOW_EXTENSION_ID,
      verdict: "deny",
      escalated: true,
      escalation: "terminal_authority",
    });
    expect(reviewerDecision?.rationale).toContain("[REDACTED_SECRET]");

    expect(harness.permissionAudit).toHaveBeenCalledWith(
      "permission_request.approved",
      expect.objectContaining({
        requestId: "call-secret",
        routingSource: "ask_escalation",
        resolution: "approved",
      }),
    );
    expect(JSON.stringify(events)).not.toContain(rawSecret);
    expect(JSON.stringify(harness.permissionAudit.mock.calls)).not.toContain(rawSecret);
  });
});

describe.each(["chat", "jev"])("%s pending-call fallback acceptance", (backend) => {
  const makeGateHarness = (complete: CompleteFn, options: HarnessOptions = {}) => createGateHarness(complete, { ...options, jev: backend === "jev" });
  it.each(["low", "high"].flatMap((riskLevel) =>
    ["Yes", "No", undefined].map((choice) => ({ riskLevel, choice })),
  ))("executes the same $riskLevel-risk call only after human Yes (choice: $choice)", async ({ riskLevel, choice }) => {
    let respond!: (value: string | undefined) => void;
    const response = new Promise<string | undefined>((resolve) => { respond = resolve; });
    const complete = vi.fn().mockResolvedValue(reviewerReply({ riskLevel, userAuthorization: "low" }));
    const harness = makeGateHarness(complete, { select: async () => response });
    const marker = join(harness.root, "executor-sentinel.txt");
    const toolCall = {
      type: "toolCall" as const,
      id: "same-pending-call",
      name: "bash",
      arguments: { command: "git status" },
    };
    // This registered test tool never launches a shell. Only the real Agent dispatcher
    // can invoke execute; its observable side effect lives in the disposable test root.
    const execute = vi.fn(async (id: string, args: unknown) => {
      const { command } = args as { command: string };
      appendFileSync(marker, `${id}:${command}\n`);
      return { content: [{ type: "text" as const, text: "sentinel executed" }], details: {} };
    });
    const runtimeModel: Model<any> = {
      id: "fixture", name: "fixture", provider: "fixture", api: "openai-responses",
      baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    };
    let emittedToolCall = false;
    const streamFunction = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const stopReason = emittedToolCall ? "stop" : "toolUse";
      emittedToolCall = true;
      const message: AssistantMessage = {
        role: "assistant", stopReason,
        content: stopReason === "toolUse" ? [toolCall] : [{ type: "text", text: "Finished." }],
        api: runtimeModel.api, provider: runtimeModel.provider, model: runtimeModel.id,
        timestamp: Date.now(),
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "done", reason: stopReason, message });
      return stream;
    });
    const beforeToolCall = vi.fn<NonNullable<Agent["beforeToolCall"]>>(async ({ toolCall: call, args }) => {
      expect(call).toEqual(toolCall);
      const result = await harness.run((args as { command: string }).command, call.id);
      return result.action === "block" ? { block: true, reason: result.reason } : undefined;
    });
    const agent = new Agent({
      initialState: {
        model: runtimeModel,
        tools: [{
          name: "bash", label: "Harmless execution sentinel",
          description: "Write a marker in a disposable test directory; never run commands.",
          parameters: Type.Object({ command: Type.String() }),
          execute,
        }],
      },
      streamFunction,
      beforeToolCall,
    });
    let settled = false;
    const pending = agent.prompt("Inspect this repository.").then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(harness.ui.select).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
      expect(agent.state.pendingToolCalls.has(toolCall.id)).toBe(true);
      expect(complete).toHaveBeenCalledOnce();
      respond(choice);
      await pending;
      expect(settled).toBe(true);
      expect(agent.state.pendingToolCalls.size).toBe(0);
      expect(execute).toHaveBeenCalledTimes(choice === "Yes" ? 1 : 0);
      if (choice === "Yes") {
        expect(execute.mock.calls[0]).toEqual(expect.arrayContaining([toolCall.id, toolCall.arguments]));
        expect(readFileSync(marker, "utf8")).toBe("same-pending-call:git status\n");
      } else {
        expect(existsSync(marker)).toBe(false);
      }
      const results = agent.state.messages.filter((message) => message.role === "toolResult");
      expect(results).toEqual([expect.objectContaining({
        toolCallId: toolCall.id, toolName: "bash", isError: choice !== "Yes",
      })]);
      expect(beforeToolCall).toHaveBeenCalledOnce();
      // One original tool request and the normal post-result reply; never a tool retry.
      expect(streamFunction).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledOnce();
      expect(harness.ui.select).toHaveBeenCalledOnce();
      expect(harness.sessionRules.getRuleset()).toEqual([]);
      expect(harness.lifecycle.recentDenials()).toEqual([]);
    } finally {
      respond(undefined);
      await pending;
    }
  });

  it.each([
    { riskLevel: "high", userAuthorization: "low", scope: "narrow", verdict: "deny" },
    { riskLevel: "high", userAuthorization: "high", scope: "broad", verdict: "deny" },
    { riskLevel: "high", userAuthorization: "low", scope: "narrow", verdict: "allow" },
  ])("lets the human decide a non-critical high-risk refusal: %j", async (decision) => {
    const complete = vi.fn().mockResolvedValue(reviewerReply(decision));
    const harness = makeGateHarness(complete, { select: async () => "Yes" });
    await expect(harness.run("npm publish", "high-risk-call")).resolves.toEqual({ action: "allow" });
    expect(harness.ui.select).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(harness.safeAudit).toHaveBeenCalledWith(
      "review.decision",
      expect.objectContaining({ verdict: "deny", escalated: true }),
    );
  });

  it.each([
    { riskLevel: "critical", verdict: "deny" },
    { riskLevel: "critical", verdict: "allow" },
    { absoluteDeny: true, verdict: "deny" },
    { absoluteDeny: true, verdict: "allow" },
  ])("keeps critical and absolute outcomes blocked: %j", async (decision) => {
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reviewerReply(decision)),
      { select: async () => "Yes" },
    );
    await expect(harness.run("git status", "floor-call")).resolves.toMatchObject({ action: "block" });
    expect(harness.ui.select).not.toHaveBeenCalled();
  });

  it("blocks transport failures without showing a prompt", async () => {
    const harness = makeGateHarness(
      vi.fn().mockRejectedValue(new Error("synthetic transport failure")),
      { select: async () => "Yes" },
    );
    await expect(harness.run("git status", "transport-call")).resolves.toMatchObject({ action: "block" });
    expect(harness.ui.select).not.toHaveBeenCalled();
  });

  it("blocks invalid reviewer output without showing a prompt", async () => {
    const invalid = { ...reviewerReply(), content: [{ type: "text", text: "not-json" }] };
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(invalid),
      { select: async () => "Yes" },
    );
    await expect(harness.run("git status", "parse-call")).resolves.toMatchObject({ action: "block" });
    expect(harness.ui.select).not.toHaveBeenCalled();
  });

  it("blocks a reviewer timeout without falling through to native approval", async () => {
    const complete: CompleteFn = async (_model, _context, options) =>
      new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("synthetic reviewer deadline"));
        if (options?.signal?.aborted) fail();
        else options?.signal?.addEventListener("abort", fail, { once: true });
      });
    const harness = makeGateHarness(complete, { select: async () => "Yes" });
    await expect(harness.run("git status", "timeout-call")).resolves.toMatchObject({ action: "block" });
    expect(harness.ui.select).not.toHaveBeenCalled();
    expect(harness.safeAudit).toHaveBeenCalledWith(
      "review.failure", expect.objectContaining({ code: "timeout" }),
    );
  });

  it("blocks a reviewer error response without showing a prompt", async () => {
    const reply = { ...reviewerReply(), stopReason: "error", errorMessage: "synthetic model error" };
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reply),
      { select: async () => "Yes" },
    );
    await expect(harness.run("git status", "model-error-call")).resolves.toMatchObject({ action: "block" });
    expect(harness.ui.select).not.toHaveBeenCalled();
  });

  it("honors a native human denial of a high-risk authorization refusal", async () => {
    const harness = makeGateHarness(
      vi.fn().mockResolvedValue(reviewerReply({ riskLevel: "high", userAuthorization: "low" })),
      { select: async () => "No" },
    );
    await expect(harness.run("npm publish", "high-risk-human-no")).resolves.toMatchObject({ action: "block" });
    expect(harness.ui.select).toHaveBeenCalledOnce();
    expect(harness.sessionRules.getRuleset()).toEqual([]);
  });

  it("does not accumulate final denial records across repeated human approvals", async () => {
    const complete = vi.fn().mockResolvedValue(reviewerReply());
    const harness = makeGateHarness(complete, { select: async () => "Yes" });
    for (let index = 0; index < 12; index++) {
      await expect(harness.run("git status", `repeated-${index}`)).resolves.toEqual({ action: "allow" });
    }
    expect(harness.ui.select).toHaveBeenCalledTimes(12);
    expect(harness.lifecycle.recentDenials()).toEqual([]);
    expect(harness.safeAudit.mock.calls.some(([event, detail]) =>
      event === "review.decision" && Boolean(detail?.circuitBreaker),
    )).toBe(false);
  });
});


describe("Jev evaluation through registered reviewer and real gate", () => {
  it("uses typed trusted criteria, redacted exact evidence, provider auth and audit identity", async () => {
    const evaluate = vi.fn().mockResolvedValue(jevAnswers());
    const apiKey = vi.fn(async () => "synthetic-key");
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate, apiKey });
    expect(await harness.run("git status", "jev-action")).toEqual({ action: "allow" });
    expect(evaluate).toHaveBeenCalledOnce();
    const request = evaluate.mock.calls[0]![0];
    expect(request.apiKey).toBe("synthetic-key");
    expect(request.questions).toEqual(JEV_QUESTIONS);
    const state = JSON.parse(request.state);
    expect(state.dossier.action.action.command).toBe("git status");
    expect(request.state).toContain("Inspect this repository.");
    expect(state.trustedPolicy.instructions).toBeTruthy();
    expect(state.trustedPolicy.policy).toBeTruthy();
    expect(request.state).not.toContain("synthetic-key");
    expect(apiKey).toHaveBeenCalledWith("vercel-ai-gateway");
    expect(harness.safeAudit).toHaveBeenCalledWith("review.decision", expect.objectContaining({ backend: "evaluation", questionContractVersion: "guardian-jev-v1", scope: "narrow", absoluteDeny: false }));
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it.each([
    { answers: {} },
    { answers: { ...jevAnswers().answers, scope: { type: "choice", choice: "unbounded" } } },
    { answers: { ...jevAnswers().answers, verdict: { type: "choice", choice: "allow", probabilities: { allow: NaN, deny: 0 } } } },
    { answers: { ...jevAnswers().answers, verdict: { type: "choice", choice: "allow", probabilities: { allow: 2, deny: -1 } } } },
  ])("blocks malformed output without native fallback: %j", async (response) => {
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate: async () => response });
    expect(await harness.run("git status", "invalid-jev")).toMatchObject({ action: "block" });
    expect(harness.ui.select).not.toHaveBeenCalled();
    expect(harness.safeAudit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "parse" }));
  });
  it("blocks missing credentials without inference", async () => {
    const evaluate = vi.fn();
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate, apiKey: async () => undefined });
    expect(await harness.run("git status", "missing-auth")).toMatchObject({ action: "block" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it.each(["auth", "evaluation"])("bounds uncooperative %s by the shared deadline", async (stage) => {
    const never = () => new Promise<never>(() => {});
    const harness = createGateHarness(vi.fn(), { jev: true, apiKey: stage === "auth" ? never : undefined, evaluate: never });
    expect(await harness.run("git status", "deadline")).toMatchObject({ action: "block" });
    expect(harness.safeAudit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "timeout" }));
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it("cancels evaluation and never falls through to human approval", async () => {
    const controller = new AbortController();
    const evaluate = vi.fn(async () => { controller.abort(); return jevAnswers(); });
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate, signal: controller.signal });
    expect(await harness.run("git status", "cancelled")).toMatchObject({ action: "block" });
    expect(harness.safeAudit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "cancelled" }));
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it("blocks audit failure before inference", async () => {
    const evaluate = vi.fn();
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate, failAudit: true });
    expect(await harness.run("git status", "audit-fail")).toMatchObject({ action: "block" });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("denies headless ordinary refusals", async () => {
    const harness = createGateHarness(vi.fn(), { jev: true, hasUI: false, evaluate: async () => jevAnswers({ verdict: "deny" }) });
    expect(await harness.run("git status", "headless")).toMatchObject({ action: "block" });
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
});


describe("Jev failure and deterministic safeguards", () => {
  it("does not evaluate deterministic denials", async () => {
    const evaluate = vi.fn();
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate });
    expect(await harness.run("denied action", "deterministic")).toMatchObject({ action: "block" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it("requires host provider-auth capability without fabricating a chat model", async () => {
    const evaluate = vi.fn();
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate, noProviderAuth: true });
    const result = await harness.run("git status", "auth-capability");
    expect(result).toMatchObject({
      action: "block",
      reason: expect.stringContaining(
        "[pi-permission-system] Automated review failed (auth);",
      ),
    });
    if (result.action !== "block") {
      throw new Error("Expected authentication failure to block");
    }
    expect(result.reason).not.toContain("public provider-auth API");
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("blocks a valid allow when final audit fails", async () => {
    const evaluate = vi.fn(async () => jevAnswers());
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate, failFinalAudit: true });
    expect(await harness.run("git status", "audit-decision")).toMatchObject({ action: "block" });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it.each([401, 402, 429, 500])("keeps service %s errors within outer attempts and redacts diagnostics", async (statusCode) => {
    const evaluate = vi.fn(async () => { throw Object.assign(new Error("synthetic-key"), { statusCode }); });
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate, maxAttempts: 2 });
    const result = await harness.run("git status", "service-error");
    expect(result).toMatchObject({ action: "block" });
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
    expect(JSON.stringify(harness.safeAudit.mock.calls)).not.toContain("synthetic-key");
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it("classifies SDK response-validation errors as parse failures", async () => {
    const evaluate = vi.fn(async () => { throw Object.assign(new Error("invalid"), { name: "AI_InvalidResponseDataError" }); });
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate });
    expect(await harness.run("git status", "sdk-parse")).toMatchObject({ action: "block" });
    expect(harness.safeAudit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "parse" }));
  });
});


describe("Jev probability validation at the real authorization seam", () => {
  function roundedAnswers(probability: number) {
    const result = jevAnswers();
    result.answers.explanationCategory = {
      ...result.answers.explanationCategory!,
      probabilities: Object.fromEntries(Object.keys(JEV_QUESTIONS.explanationCategory.criteria).map((key) => [key, probability])),
    } as typeof result.answers.explanationCategory;
    return result;
  }
  it("accepts valid rounded distributions without changing the selected verdict", async () => {
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate: async () => ({ ...roundedAnswers(0.17), rounding: { probabilityDecimals: 2 } }) });
    expect(await harness.run("git status", "rounded-allow")).toEqual({ action: "allow" });
    expect(harness.safeAudit).toHaveBeenCalledWith("review.decision", expect.objectContaining({ scope: "narrow", absoluteDeny: false }));
  });
  it.each([
    { ...roundedAnswers(0.17) },
    { ...roundedAnswers(0.3), rounding: { probabilityDecimals: 2 } },
    ...[-1, 16, 1.5, NaN, Infinity, "2"].map((probabilityDecimals) => ({ ...roundedAnswers(0.17), rounding: { probabilityDecimals } })),
    { ...roundedAnswers(0.17), rounding: "2" },
    { ...roundedAnswers(0.17), rounding: { probabilityDecimals: 2, scoreDecimals: 99 } },
  ])("rejects malformed distributions or precision metadata: %j", async (result) => {
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate: async () => result });
    expect(await harness.run("git status", "rounded-invalid")).toMatchObject({ action: "block" });
    expect(harness.safeAudit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "parse" }));
    expect(harness.ui.select).not.toHaveBeenCalled();
  });
  it("records absolute denial and scope in the normalized audit", async () => {
    const harness = createGateHarness(vi.fn(), { jev: true, evaluate: async () => jevAnswers({ absoluteDeny: true, scope: "broad" }) });
    expect(await harness.run("git status", "audit-absolute")).toMatchObject({ action: "block" });
    expect(harness.safeAudit).toHaveBeenCalledWith("review.decision", expect.objectContaining({ verdict: "deny", scope: "broad", absoluteDeny: true }));
  });
});
