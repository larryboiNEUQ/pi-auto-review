import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  publishPermissionsService, unpublishPermissionsService,
  type PermissionsService,
} from "@gotgenes/pi-permission-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAFE_ALLOW_EXTENSION_ID, withDefaults } from "#safe/config-schema";
import { createSafeAllowExtension } from "#safe/extension";
import { makeDetails, makeFacts } from "#test/fixtures";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Outcome = "deny" | "allow" | "defer";

describe.each(["chat", "jev"] as const)("requester-owned stopping (%s)", (backend) => {
  let root: string;
  let published: PermissionsService;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalVerbose = process.env.PI_SAFE_ALLOW_VERBOSE;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "safe-allow-forwarded-breaker-"));
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_SAFE_ALLOW_VERBOSE;
  });
  afterEach(() => {
    unpublishPermissionsService(published);
    rmSync(root, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalVerbose === undefined) delete process.env.PI_SAFE_ALLOW_VERBOSE;
    else process.env.PI_SAFE_ALLOW_VERBOSE = originalVerbose;
    vi.restoreAllMocks();
  });

  async function harness() {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      events: { on: vi.fn().mockReturnValue(() => undefined) },
      registerCommand: vi.fn(), appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
    const registered = vi.fn().mockReturnValue(() => undefined);
    published = { registerAuthorizer: registered } as unknown as PermissionsService;
    publishPermissionsService(published);
    const selected = (backend === "chat"
      ? { provider: "gateway", id: "fixture-reviewer" }
      : { provider: "vercel-ai-gateway", id: "typesafe-ai/jev" });
    const model = { ...selected, contextWindow: 128_000, maxTokens: 4_096 } as Model<any>;
    const complete = vi.fn();
    const evaluate = vi.fn();
    const ctx = {
      cwd: "/work/repo",
      modelRegistry: {
        find: () => model, getAvailable: () => [model],
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true }),
        getApiKeyForProvider: vi.fn().mockResolvedValue("fixture-key"),
      },
      sessionManager: {
        getEntries: () => [], getBranch: () => [], buildContextEntries: () => [],
      },
      ui: { notify: vi.fn() }, abort: vi.fn(),
    } as unknown as ExtensionContext;
    createSafeAllowExtension(pi, {
      loadConfig: () => ({ config: withDefaults({ provider: selected.provider, model: selected.id }), issues: [] }),
      getBatchProvenance: () => "single", complete, evaluate,
    });
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    expect(registered).toHaveBeenCalledTimes(1);
    const reviewer = registered.mock.calls[0]![1];
    const query = { checkPermission: vi.fn(), getToolPermission: vi.fn(), resolveTarget: vi.fn() };
    function choose(outcome: Outcome) {
      const choices = outcome === "deny"
        ? { riskLevel: "critical", userAuthorization: "unknown", verdict: "deny", absoluteDeny: "yes", explanationCategory: "critical_risk" }
        : outcome === "allow"
          ? { riskLevel: "low", userAuthorization: "medium", verdict: "allow", absoluteDeny: "no", explanationCategory: "policy_permitted" }
          : { riskLevel: "high", userAuthorization: "unknown", verdict: "deny", absoluteDeny: "no", explanationCategory: "insufficient_authorization" };
      complete.mockResolvedValue({
        role: "assistant", stopReason: "stop", timestamp: Date.now(),
        content: [{ type: "text", text: JSON.stringify({ ...choices,
          absoluteDeny: choices.absoluteDeny === "yes", scope: "narrow", rationale: "Controlled fixture verdict." }) }],
      } as AssistantMessage);
      evaluate.mockResolvedValue({ answers: Object.fromEntries(Object.entries({ ...choices, scope: "narrow" })
        .map(([key, choice]) => [key, { type: "choice", choice }])) });
    }
    async function review(id: string, forwarded = false) {
      const details = makeDetails(makeFacts({ requestId: id, exactActionId: `${id}-action` }));
      return reviewer(forwarded ? { ...details, forwardedBatchProvenance: "single", forwardedHostVersion: "0.99.1",
        forwarding: { requesterAgentName: "fixture-child", requesterSessionId: `${id}-session` } } : details, query);
    }
    function expectCalls(count: number) {
      expect(backend === "chat" ? complete : evaluate).toHaveBeenCalledTimes(count);
      expect(backend === "chat" ? evaluate : complete).not.toHaveBeenCalled();
    }
    return { ctx, handlers, choose, review, expectCalls };
  }

  it("returns three child hard refusals without stopping or notifying the parent", async () => {
    const fixture = await harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.choose("deny");
    for (let i = 0; i < 3; i++) {
      expect(await fixture.review(`child-${i}`, true)).toMatchObject({ kind: "deny", source: "reviewer", reason: expect.any(String) });
    }
    fixture.expectCalls(3);
    expect(fixture.ctx.abort).not.toHaveBeenCalled();
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    const decisions = readFileSync(join(root, "extensions", SAFE_ALLOW_EXTENSION_ID, "logs", "safe-allow.jsonl"), "utf-8")
      .trim().split("\n").map((line) => JSON.parse(line)).filter(({ event }) => event === "review.decision");
    expect(decisions).toHaveLength(3);
    expect(decisions.every(({ verdict, denialId, circuitBreaker }) =>
      verdict === "deny" && typeof denialId === "string" && circuitBreaker === null)).toBe(true);
  });

  it("still requests a stop after three local hard refusals", async () => {
    const fixture = await harness();
    fixture.choose("deny");
    for (let i = 0; i < 3; i++) expect(await fixture.review(`local-${i}`)).toMatchObject({ kind: "deny" });
    fixture.expectCalls(3);
    expect(fixture.ctx.abort).toHaveBeenCalledTimes(1);
  });

  it.each(["allow", "defer"] as const)("a child %s cannot reset the parent's hard-refusal streak", async (childOutcome) => {
    const fixture = await harness();
    fixture.choose("deny");
    expect(await fixture.review("local-0")).toMatchObject({ kind: "deny" });
    fixture.choose(childOutcome);
    expect(await fixture.review("child", true)).toMatchObject({ kind: childOutcome });
    expect(fixture.ctx.abort).not.toHaveBeenCalled();
    fixture.choose("deny");
    expect(await fixture.review("local-1")).toMatchObject({ kind: "deny" });
    expect(await fixture.review("local-2")).toMatchObject({ kind: "deny" });
    fixture.expectCalls(4);
    expect(fixture.ctx.abort).toHaveBeenCalledTimes(1);
  });
});
