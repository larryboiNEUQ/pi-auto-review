import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeAuthorizerChain } from "#src/authority/authorizer-chain";
import { encloseInDelegationEnvelope } from "#src/authority/delegation-envelope";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import { PermissionPrompter } from "#src/authority/permission-prompter";
import { GateRunner } from "#src/handlers/gates/runner";
import { describeToolGate } from "#src/handlers/gates/tool";
import { PermissionManager } from "#src/permission-manager";
import { PermissionResolver } from "#src/permission-resolver";
import type { PermissionQuery } from "#src/service";
import { SessionRules } from "#src/session-rules";
import { resolveToolPreviewLimits, ToolPreviewFormatter } from "#src/tool-preview-formatter";
import { withDefaults } from "#safe/config-schema";
import { DenialLifecycle } from "#safe/denial-lifecycle";
import type { CompleteFn, ModelRegistryLike } from "#safe/model-review";
import { createSafeAllowReviewer } from "#safe/safe-allow-reviewer";

const model = {} as Model<any>;
const roots: string[] = [];

afterEach(() => {
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

function makeGateHarness(
  complete: CompleteFn,
  select: (title: string, options: string[]) => Promise<string | undefined>,
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
      },
    },
  }));

  const sessionRules = new SessionRules();
  const manager = new PermissionManager({ globalConfigPath, agentsDir });
  const resolver = new PermissionResolver(manager, sessionRules);
  const config = withDefaults({ timeoutMs: 100, maxAttempts: 1 });
  const lifecycle = new DenialLifecycle();
  const safeAudit = vi.fn().mockReturnValue(true);
  const reviewer = createSafeAllowReviewer({
    getConfig: () => config,
    getRegistry: () => ({
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true }),
    }) as ModelRegistryLike,
    getEvidence: () => [{ role: "user", content: "Inspect this repository." }],
    getSignal: () => undefined,
    lifecycle,
    complete,
    audit: safeAudit,
  });

  const permissionAudit = vi.fn();
  const permissionEvents = { emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) };
  const ui = { select: vi.fn(select), input: vi.fn(), custom: vi.fn() };
  const localUser = new LocalUserAuthorizer({
    ui,
    mode: "rpc",
    events: permissionEvents,
    getPromptPreferences: () => ({ doublePressToConfirm: true }),
    requestPermissionDecision,
  });
  const chain = composeAuthorizerChain(
    [{ authorize: encloseInDelegationEnvelope(reviewer, config.pathEnvelopeMode) }],
    localUser,
    resolver as unknown as PermissionQuery,
  );
  const prompter = new PermissionPrompter({ logger: { review: permissionAudit } });
  const reporter = { writeReviewLog: vi.fn(), emitDecision: vi.fn() };
  const runner = new GateRunner(
    resolver,
    sessionRules,
    { escalate: (details) => prompter.prompt(chain, details) },
    reporter,
  );
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

describe("ordinary Safe-Allow denial escalation through the real gate", () => {
  it("continues the same pending request after native one-time approval", async () => {
    const complete = vi.fn().mockResolvedValue(reviewerReply());
    const harness = makeGateHarness(complete, async (_title, options) => {
      expect(options).toEqual([
        "Yes",
        expect.stringContaining("for this session"),
        "No",
        "No, provide reason",
      ]);
      return "Yes";
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
    const harness = makeGateHarness(complete, async (_title, options) => {
      promptCount += 1;
      if (promptCount === 1) {
        return options[1];
      }
      return "No";
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
});
