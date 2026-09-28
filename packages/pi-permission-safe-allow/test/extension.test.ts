import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  publishPermissionsService,
  unpublishPermissionsService,
  type PermissionsService,
} from "@gotgenes/pi-permission-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withDefaults } from "#safe/config-schema";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadSafeAllowConfig,
} from "#safe/config-loader";
import { createSafeAllowExtension } from "#safe/extension";
import { REVIEWER_MODEL_SESSION_ENTRY } from "#safe/reviewer-model-session";
import { makeDetails } from "#test/fixtures";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Command = {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
};

function reviewerReply(): AssistantMessage {
  return {
    role: "assistant",
    content: [{
      type: "text",
      text: JSON.stringify({
        riskLevel: "low",
        userAuthorization: "medium",
        verdict: "allow",
        rationale: "The exact inspection is authorized.",
        scope: "narrow",
        absoluteDeny: false,
      }),
    }],
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function model(provider: string, id: string): Model<any> {
  return { provider, id } as Model<any>;
}

describe.each([
  { kind: "chat", provider: "gateway", id: "team/reviewer-v2" },
  { kind: "evaluation", provider: "vercel-ai-gateway", id: "typesafe-ai/jev" },
])("safe-allow extension integration ($kind reviewer)", (selected) => {
  const selectedRef = `${selected.provider}/${selected.id}`;
  const selectedReference = { provider: selected.provider, model: selected.id };
  function expectSelectedInvocation(fixture: ReturnType<typeof harness>) {
    if (selected.kind === "evaluation") {
      expect(fixture.evaluate).toHaveBeenCalledTimes(1);
      expect(fixture.complete).not.toHaveBeenCalled();
    } else {
      expect(fixture.complete.mock.calls.at(-1)![0]).toBe(fixture.namespaced);
      expect(fixture.evaluate).not.toHaveBeenCalled();
    }
  }
  let published: PermissionsService | undefined;
  const temporaryRoots: string[] = [];
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    const agentDir = mkdtempSync(join(tmpdir(), "safe-allow-extension-agent-"));
    temporaryRoots.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (published) unpublishPermissionsService(published);
    published = undefined;
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function harness(options: { scoped?: Model<any>[]; configRoot?: string } = {}) {
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, Command>();
    const entries: any[] = [];
    const appendEntry = vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    });
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      events: { on: vi.fn().mockReturnValue(() => undefined) },
      registerCommand: vi.fn((name: string, definition: Command) => {
        commands.set(name, definition);
      }),
      appendEntry,
    } as unknown as ExtensionAPI;

    const registered = vi.fn().mockReturnValue(() => undefined);
    published = {
      checkPermission: vi.fn(),
      getToolPermission: vi.fn(),
      registerToolInputFormatter: vi.fn(),
      registerToolAccessExtractor: vi.fn(),
      registerAuthorizer: registered,
    } as unknown as PermissionsService;
    publishPermissionsService(published);

    const base = model("openai-codex", "gpt-5.4-mini");
    const namespaced = model(selected.provider, selected.id);
    const hidden = model("hidden", "reviewer");
    const models = [base, ...(selected.kind === "chat" ? [namespaced] : []), hidden];
    const auth = vi.fn().mockResolvedValue({ ok: true });
    const providerAuth = vi.fn().mockResolvedValue("synthetic-gateway-key");
    const registry = {
      find: vi.fn((provider: string, id: string) =>
        models.find((candidate) => candidate.provider === provider && candidate.id === id),
      ),
      getAvailable: vi.fn(() => models),
      getApiKeyAndHeaders: auth,
      getApiKeyForProvider: providerAuth,
    };
    const complete = vi.fn().mockResolvedValue(reviewerReply());
    const evaluate = vi.fn().mockResolvedValue({ answers: Object.fromEntries(Object.entries({
      riskLevel: "low", userAuthorization: "medium", verdict: "allow", scope: "narrow",
      absoluteDeny: "no", explanationCategory: "policy_permitted",
    }).map(([key, choice]) => [key, { type: "choice", choice }])) });

    const cwd = options.configRoot ? join(options.configRoot, "repo") : "/work/repo";
    const agentDir = options.configRoot
      ? join(options.configRoot, "agent")
      : undefined;
    if (options.configRoot) mkdirSync(cwd, { recursive: true });

    createSafeAllowExtension(pi, {
      loadConfig: options.configRoot
        ? (workingDirectory) =>
          loadSafeAllowConfig({ cwd: workingDirectory, agentDir })
        : () => ({
          config: withDefaults({}),
          issues: [],
          reviewerModelSource: "built-in default",
        }),
      complete,
      evaluate,
    });

    const notify = vi.fn();
    const select = vi.fn();
    const custom = vi.fn();
    const ctx = {
      cwd,
      modelRegistry: registry,
      scopedModels: (options.scoped ?? []).map((scopedModel) => ({
        model: scopedModel,
      })),
      sessionManager: {
        getEntries: vi.fn(() => entries),
        getBranch: vi.fn(() => entries),
      },
      ui: { notify, select, custom },
      abort: vi.fn(),
    } as unknown as ExtensionContext;

    return {
      handlers,
      commands,
      entries,
      appendEntry,
      registered,
      registry,
      auth,
      providerAuth,
      complete,
      evaluate,
      ctx,
      notify,
      select,
      custom,
      base,
      namespaced,
      hidden,
    };
  }

  async function start(
    fixture: ReturnType<typeof harness>,
    reason = "startup",
    previousSessionFile?: string,
  ) {
    await fixture.handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason, previousSessionFile },
      fixture.ctx,
    );
  }

  async function shutdown(fixture: ReturnType<typeof harness>) {
    await fixture.handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown" },
      fixture.ctx,
    );
  }

  it("registers the delegated reviewer and commands once on the real lifecycle", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    await start(fixture);

    expect(fixture.registered).toHaveBeenCalledWith(
      "safe-allow",
      expect.any(Function),
      { pathEnvelopeMode: "cap-allow" },
    );
    expect(fixture.commands.has("approve")).toBe(true);
    expect(fixture.commands.has("review-model")).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.registered).toHaveBeenCalledTimes(1);
  });

  it("switches directly to a namespaced Session reviewer and the captured authorizer uses it next", async () => {
    const fixture = harness();
    await start(fixture);
    const reviewer = fixture.registered.mock.calls[0]![1];

    await fixture.commands.get("review-model")!.handler(
      selectedRef,
      fixture.ctx,
    );

    if (selected.kind === "evaluation") {
      expect(fixture.providerAuth).toHaveBeenCalledWith(selected.provider);
    } else {
      expect(fixture.auth).toHaveBeenCalledWith(fixture.namespaced);
    }
    expect(fixture.evaluate).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.appendEntry).toHaveBeenCalledWith(
      REVIEWER_MODEL_SESSION_ENTRY,
      {
        version: 1,
        selection: selectedReference,
      },
    );
    expect(fixture.registered).toHaveBeenCalledTimes(1);

    const outcome = await reviewer(makeDetails(), {
      checkPermission: vi.fn(),
      getToolPermission: vi.fn(),
      resolveTarget: vi.fn(),
    });
    expect(outcome).toEqual({ kind: "allow" });
    expectSelectedInvocation(fixture);

    await fixture.commands.get("review-model")!.handler("openai-codex/gpt-5.4-mini", fixture.ctx);
    fixture.complete.mockClear();
    fixture.evaluate.mockClear();
    expect(await reviewer(makeDetails(), { checkPermission: vi.fn(), getToolPermission: vi.fn(), resolveTarget: vi.fn() }))
      .toEqual({ kind: "allow" });
    expect(fixture.complete.mock.calls.at(-1)![0]).toBe(fixture.base);
    expect(fixture.evaluate).not.toHaveBeenCalled();
    expect(fixture.registered).toHaveBeenCalledTimes(1);
  });

  it("uses Pi's scoped model set for the reviewer picker and cancellation is inert", async () => {
    const fixture = harness();
    (fixture.ctx as any).scopedModels = [
      { model: fixture.base },
      { model: fixture.namespaced },
    ];
    await start(fixture);
    const command = fixture.commands.get("review-model")!;

    fixture.custom.mockResolvedValueOnce(undefined);
    await command.handler("", fixture.ctx);
    expect(fixture.custom).toHaveBeenCalledTimes(1);
    expect(fixture.select).not.toHaveBeenCalled();
    expect(fixture.appendEntry).not.toHaveBeenCalled();

    fixture.custom.mockResolvedValueOnce(selectedRef);
    fixture.select.mockResolvedValueOnce(undefined);
    await command.handler("", fixture.ctx);
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.select).toHaveBeenCalledWith(
      "Apply reviewer model to which scope?",
      ["Session (default)", "Project", "Global"],
    );

    fixture.custom.mockResolvedValueOnce(selectedRef);
    fixture.select.mockResolvedValueOnce("Session (default)");
    await command.handler("", fixture.ctx);
    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("keeps unavailable authentication and cancellation inert in every scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-auth-scope-"));
    temporaryRoots.push(root);
    const projectPath = getProjectConfigPath(join(root, "repo"));
    const globalPath = getGlobalConfigPath(join(root, "agent"));
    for (const path of [projectPath, globalPath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{ "timeoutMs": 4321 }');
    }
    const fixture = harness({ configRoot: root });
    await start(fixture);
    const command = fixture.commands.get("review-model")!;
    if (selected.kind === "evaluation") fixture.providerAuth.mockResolvedValue(undefined);
    else fixture.auth.mockResolvedValue({ ok: false });
    for (const flag of ["", " --project", " --global"]) {
      await command.handler(selectedRef + flag, fixture.ctx);
      expect(fixture.notify.mock.calls.at(-1)![0]).toContain("authentication is unavailable");
    }
    fixture.custom.mockResolvedValueOnce(selectedRef);
    fixture.select.mockResolvedValueOnce(undefined);
    await command.handler("", fixture.ctx);
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    for (const path of [projectPath, globalPath]) expect(readFileSync(path, "utf8")).toBe('{ "timeoutMs": 4321 }');
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.evaluate).not.toHaveBeenCalled();
    await command.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain("openai-codex/gpt-5.4-mini; source: built-in default");
  });

  it("provides safe recovery guidance when Jev credentials or host capability are missing", async () => {
    const fixture = harness();
    await start(fixture);
    const command = fixture.commands.get("review-model")!;
    fixture.providerAuth.mockResolvedValue(undefined);
    await command.handler("vercel-ai-gateway/typesafe-ai/jev", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain("configure Vercel AI Gateway authentication in Pi");
    delete (fixture.registry as Partial<typeof fixture.registry>).getApiKeyForProvider;
    await command.handler("vercel-ai-gateway/typesafe-ai/jev", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain("update Pi to a compatible version");
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.evaluate).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("adds only supported Jev to the scoped picker without changing Pi's catalogue", async () => {
    const fixture = harness();
    (fixture.ctx as any).scopedModels = [{ model: fixture.base }];
    await start(fixture);
    let rendered = "";
    fixture.custom.mockImplementationOnce(async (factory: any) => {
      const component = factory({ requestRender: vi.fn() }, {
        bold: (text: string) => text, fg: (_color: string, text: string) => text,
      }, {}, vi.fn());
      rendered = component.render(100).join("\n");
      return null;
    });
    const command = fixture.commands.get("review-model")!;
    await command.handler("", fixture.ctx);
    expect(rendered).toContain("vercel-ai-gateway/typesafe-ai/jev");
    expect(rendered).toContain("(evaluation reviewer)");
    expect(rendered).not.toContain("hidden/reviewer");
    expect(fixture.registry.find("vercel-ai-gateway", "typesafe-ai/jev")).toBeUndefined();
    await command.handler("hidden/reviewer", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain("outside the current Pi model scope");
    await command.handler("vercel-ai-gateway/typesafe-ai/unknown", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain("does not exist");
    await command.handler("vercel-ai-gateway/typesafe-ai/jev", fixture.ctx);
    expect(fixture.entries.at(-1)?.data.selection).toEqual({ provider: "vercel-ai-gateway", model: "typesafe-ai/jev" });
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.evaluate).not.toHaveBeenCalled();
  });

  it("searches by model name and selects the filtered reviewer", async () => {
    const fixture = harness();
    fixture.select.mockResolvedValueOnce("Session");
    await start(fixture);
    fixture.custom.mockImplementationOnce((factory: any) => new Promise((done) => {
      const component = factory({ requestRender: vi.fn() }, {
        bold: (text: string) => text, fg: (_color: string, text: string) => text,
      }, {}, done);
      component.focused = true;
      expect(component.focused).toBe(true);
      const query = selected.kind === "evaluation" ? "JEV" : "reviewer-v2";
      for (const character of query) component.handleInput(character);
      const rendered = component.render(120).join("\n");
      expect(rendered).toContain("Type to search");
      expect(rendered).toContain("Current reviewer: openai-codex/gpt-5.4-mini");
      expect(rendered).toContain(selectedRef);
      expect(rendered).not.toContain("hidden/reviewer");
      component.handleInput("\r");
    }));
    await fixture.commands.get("review-model")!.handler("", fixture.ctx);
    expect(fixture.entries.at(-1)?.data.selection).toEqual(selectedReference);
  });

  it("keeps empty searches inert, restores results on deletion, and cancels without switching", async () => {
    const fixture = harness();
    await start(fixture);
    await fixture.commands.get("review-model")!.handler(selectedRef, fixture.ctx);
    const before = fixture.entries.length;
    fixture.custom.mockImplementationOnce((factory: any) => new Promise((done) => {
      const finish = vi.fn(done);
      const component = factory({ requestRender: vi.fn() }, {
        bold: (text: string) => text, fg: (_color: string, text: string) => text,
      }, {}, finish);
      for (const character of "zzzzzz") component.handleInput(character);
      const empty = component.render(120).join("\n");
      expect(empty).toContain("No matching reviewer models");
      expect(empty).toContain(`Current reviewer: ${selectedRef}`);
      expect(empty).toContain("Source: Session");
      component.handleInput("\x1b[B");
      component.handleInput("\r");
      expect(finish).not.toHaveBeenCalled();
      for (let i = 0; i < 6; i++) component.handleInput("\x7f");
      expect(component.render(100).join("\n")).toContain("vercel-ai-gateway/typesafe-ai/jev");
      component.handleInput("j");
      component.handleInput("\x1b");
      expect(finish).toHaveBeenCalledWith(null);
    }));
    await fixture.commands.get("review-model")!.handler("", fixture.ctx);
    expect(fixture.entries).toHaveLength(before);
  });

  it("keeps the selected reviewer visible when the catalogue exceeds a small pane", async () => {
    const fixture = harness();
    (fixture.ctx as any).scopedModels = Array.from({ length: 30 }, (_, index) => ({
      model: model("provider", `model-${String(index).padStart(2, "0")}`),
    }));
    await start(fixture);
    let rendered: string[] = [];

    fixture.custom.mockImplementationOnce(async (factory: any) => {
      let finish!: (value: string | null) => void;
      const result = new Promise<string | null>((resolve) => {
        finish = resolve;
      });
      const component = factory(
        { requestRender: vi.fn() },
        {
          bold: (text: string) => text,
          fg: (_color: string, text: string) => text,
        },
        {},
        finish,
      );
      component.handleInput?.("\x1b[B");
      rendered = component.render(60);
      component.handleInput?.("\x1b");
      return result;
    });

    await fixture.commands.get("review-model")!.handler("", fixture.ctx);

    expect(fixture.custom).toHaveBeenCalledTimes(1);
    expect(rendered.join("\n")).toContain("Current reviewer: openai-codex/gpt-5.4-mini");
    expect(rendered.length).toBeLessThanOrEqual(14);
    expect(rendered.join("\n")).toContain(
      "Safe-allow reviewer model (independent from Pi /model)",
    );
    expect(rendered.some((line) => line.includes("→ provider/model-01"))).toBe(
      true,
    );
  });

  it("rejects malformed, out-of-scope, and unauthenticated switches atomically", async () => {
    const fixture = harness();
    (fixture.ctx as any).scopedModels = [
      { model: fixture.base },
      { model: fixture.namespaced },
    ];
    await start(fixture);
    const command = fixture.commands.get("review-model")!;

    await command.handler(selectedRef, fixture.ctx);
    await command.handler("gateway", fixture.ctx);
    await command.handler("hidden/reviewer", fixture.ctx);
    fixture.auth.mockResolvedValueOnce({ ok: false, error: "secret credential detail" });
    await command.handler("openai-codex/gpt-5.4-mini", fixture.ctx);
    fixture.auth.mockRejectedValueOnce(new Error("secret auth backend failure"));
    await command.handler("openai-codex/gpt-5.4-mini", fixture.ctx);

    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
    await command.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      `${selectedRef}; source: Session`,
    );
    expect(fixture.complete).not.toHaveBeenCalled();
    const notifications = fixture.notify.mock.calls.flat().join(" ");
    expect(notifications).not.toContain("secret credential detail");
    expect(notifications).not.toContain("secret auth backend failure");
  });

  it("show reports model, source, and credential validation without authentication material", async () => {
    const fixture = harness();
    await start(fixture);
    const command = fixture.commands.get("review-model")!;
    await command.handler("show", fixture.ctx);
    expect(fixture.notify).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "openai-codex/gpt-5.4-mini; source: built-in default; validation: valid",
      ),
      "info",
    );

    await command.handler(selectedRef, fixture.ctx);
    if (selected.kind === "evaluation") fixture.providerAuth.mockResolvedValueOnce(undefined);
    else fixture.auth.mockResolvedValueOnce({ ok: false, error: "token sk-do-not-display" });
    await command.handler("show", fixture.ctx);
    expect(fixture.notify).toHaveBeenLastCalledWith(
      expect.stringContaining(
        `${selectedRef}; source: Session; validation: invalid`,
      ),
      "warning",
    );
    expect(fixture.notify.mock.calls.at(-1)![0]).not.toContain("sk-do-not-display");
  });

  it("reset clears only Session state and immediately restores the configured reviewer", async () => {
    const fixture = harness();
    await start(fixture);
    const command = fixture.commands.get("review-model")!;
    await command.handler(selectedRef, fixture.ctx);
    await command.handler("reset", fixture.ctx);

    expect(fixture.entries.at(-1)).toEqual({
      type: "custom",
      customType: REVIEWER_MODEL_SESSION_ENTRY,
      data: { version: 1, selection: null },
    });
    expect(fixture.notify).toHaveBeenLastCalledWith(
      "Session reviewer model reset to openai-codex/gpt-5.4-mini (built-in default).",
      "info",
    );
  });

  it("restores Session selection on reload and resume, but not for a new session", async () => {
    const fixture = harness();
    await start(fixture);
    const command = fixture.commands.get("review-model")!;
    await command.handler(selectedRef, fixture.ctx);

    for (const reason of ["reload", "resume", "clone"]) {
      await shutdown(fixture);
      await start(fixture, reason);
      await command.handler("show", fixture.ctx);
      expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
        `${selectedRef}; source: Session`,
      );
    }

    await shutdown(fixture);
    fixture.entries.splice(0);
    await start(fixture, "new");
    await command.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      "openai-codex/gpt-5.4-mini; source: built-in default",
    );
  });

  it("keeps Session reviewer after reload when the current branch tip predates the selection", async () => {
    const fixture = harness();
    await start(fixture);
    const command = fixture.commands.get("review-model")!;
    await command.handler(selectedRef, fixture.ctx);

    const fullHistory = [...fixture.entries];
    const olderBranch = fullHistory.filter(
      (entry) => entry.customType !== REVIEWER_MODEL_SESSION_ENTRY,
    );
    expect(fullHistory.some((entry) => entry.customType === REVIEWER_MODEL_SESSION_ENTRY)).toBe(
      true,
    );
    expect(olderBranch.some((entry) => entry.customType === REVIEWER_MODEL_SESSION_ENTRY)).toBe(
      false,
    );

    (fixture.ctx.sessionManager.getEntries as ReturnType<typeof vi.fn>).mockImplementation(
      () => fullHistory,
    );
    (fixture.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockImplementation(
      () => olderBranch,
    );

    await shutdown(fixture);
    await start(fixture, "reload");
    await command.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      `${selectedRef}; source: Session`,
    );
  });

  it("fork inherits the source active reviewer over historical child state", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-fork-active-"));
    temporaryRoots.push(root);
    const source = SessionManager.create(root, root);
    source.appendMessage(reviewerReply());
    source.appendCustomEntry(REVIEWER_MODEL_SESSION_ENTRY, {
      version: 1,
      selection: selectedReference,
    });
    const fixture = harness();
    fixture.entries.push({
      type: "custom",
      customType: REVIEWER_MODEL_SESSION_ENTRY,
      data: {
        version: 1,
        selection: { provider: "hidden", model: "reviewer" },
      },
    });

    await start(fixture, "fork", source.getSessionFile());
    await fixture.commands.get("review-model")!.handler("show", fixture.ctx);

    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      `${selectedRef}; source: Session`,
    );
    expect(fixture.entries.at(-1)?.data.selection).toEqual({
      ...selectedReference,
    });
    await start(fixture, "reload");
    await fixture.commands.get("review-model")!.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      `${selectedRef}; source: Session`,
    );
    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("fork inherits and persists an explicit source Session reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-fork-reset-"));
    temporaryRoots.push(root);
    const source = SessionManager.create(root, root);
    source.appendMessage(reviewerReply());
    source.appendCustomEntry(REVIEWER_MODEL_SESSION_ENTRY, {
      version: 1,
      selection: null,
    });
    const fixture = harness();
    fixture.entries.push({
      type: "custom",
      customType: REVIEWER_MODEL_SESSION_ENTRY,
      data: {
        version: 1,
        selection: { provider: "hidden", model: "reviewer" },
      },
    });

    await start(fixture, "fork", source.getSessionFile());
    await fixture.commands.get("review-model")!.handler("show", fixture.ctx);

    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      "openai-codex/gpt-5.4-mini; source: built-in default",
    );
    expect(fixture.entries.at(-1)?.data).toEqual({ version: 1, selection: null });
  });

  it("falls back to child fork history when its source is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-missing-source-"));
    temporaryRoots.push(root);
    const fixture = harness();
    fixture.entries.push({
      type: "custom",
      customType: REVIEWER_MODEL_SESSION_ENTRY,
      data: { version: 1, selection: { provider: "hidden", model: "reviewer" } },
    });
    await start(fixture, "fork", join(root, "missing.jsonl"));
    await fixture.commands.get("review-model")!.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      "hidden/reviewer; source: Session",
    );
    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });

  it("persists narrow Project and Global selections with precedence and immediate invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-persistence-"));
    temporaryRoots.push(root);
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const projectPath = getProjectConfigPath(cwd);
    const globalPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(projectPath), { recursive: true });
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(projectPath, JSON.stringify({
      provider: "hidden",
      model: "reviewer",
      timeoutMs: 1234,
      policyPath: "guardian.md",
    }));
    writeFileSync(join(dirname(projectPath), "guardian.md"), "PROJECT POLICY");
    writeFileSync(globalPath, JSON.stringify({
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      includeToolResults: true,
    }));

    const fixture = harness({ configRoot: root });
    await start(fixture);
    const reviewer = fixture.registered.mock.calls[0]![1];
    const command = fixture.commands.get("review-model")!;
    await command.handler(`${selectedRef} --global`, fixture.ctx);

    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
      ...selectedReference,
      includeToolResults: true,
    });
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toMatchObject({
      provider: "hidden",
      model: "reviewer",
      timeoutMs: 1234,
      policyPath: "guardian.md",
    });
    await reviewer(makeDetails(), {
      checkPermission: vi.fn(),
      getToolPermission: vi.fn(),
      resolveTarget: vi.fn(),
    });
    expectSelectedInvocation(fixture);

    const nextSession = harness({ configRoot: root });
    await start(nextSession, "new");
    await nextSession.commands.get("review-model")!.handler("show", nextSession.ctx);
    expect(nextSession.notify.mock.calls.at(-1)![0]).toContain(
      "hidden/reviewer; source: Project",
    );

    await nextSession.commands.get("review-model")!.handler(
      "reset --project",
      nextSession.ctx,
    );
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({
      timeoutMs: 1234,
      policyPath: "guardian.md",
    });
    expect(nextSession.notify.mock.calls.at(-1)![0]).toContain(
      `${selectedRef} (Global)`,
    );

    await nextSession.commands.get("review-model")!.handler(
      "hidden/reviewer --project",
      nextSession.ctx,
    );
    await nextSession.commands.get("review-model")!.handler(
      "reset --global",
      nextSession.ctx,
    );
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
      includeToolResults: true,
    });
    expect(nextSession.notify.mock.calls.at(-1)![0]).toContain(
      "hidden/reviewer (Project)",
    );
  });

  it("supports interactive Project persistence and creates a minimal missing config", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-interactive-"));
    temporaryRoots.push(root);
    const fixture = harness({ configRoot: root });
    await start(fixture);
    fixture.custom.mockResolvedValueOnce(selectedRef);
    fixture.select.mockResolvedValueOnce("Project");

    await fixture.commands.get("review-model")!.handler("", fixture.ctx);

    expect(JSON.parse(readFileSync(getProjectConfigPath(join(root, "repo")), "utf8")))
      .toEqual(selectedReference);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      "Project reviewer model switched",
    );
  });

  it("persists interactive Global selection and uses it immediately", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-interactive-global-"));
    temporaryRoots.push(root);
    const globalPath = getGlobalConfigPath(join(root, "agent"));
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, "{\n  \"includeToolResults\": true\n}\n");
    const fixture = harness({ configRoot: root });
    await start(fixture);
    const reviewer = fixture.registered.mock.calls[0]![1];
    fixture.custom.mockResolvedValueOnce(selectedRef);
    fixture.select.mockResolvedValueOnce("Global");

    await fixture.commands.get("review-model")!.handler("", fixture.ctx);

    expect(readFileSync(globalPath, "utf8")).toBe(
      JSON.stringify({ includeToolResults: true, ...selectedReference }, null, 2) + "\n",
    );
    expect(fixture.entries.at(-1)).toEqual({
      type: "custom",
      customType: REVIEWER_MODEL_SESSION_ENTRY,
      data: {
        version: 1,
        selection: selectedReference,
      },
    });
    await fixture.commands.get("review-model")!.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      `${selectedRef}; source: Session`,
    );

    await reviewer(makeDetails(), {
      checkPermission: vi.fn(),
      getToolPermission: vi.fn(),
      resolveTarget: vi.fn(),
    });
    expectSelectedInvocation(fixture);
  });

  it("reports the lower complete pair when Project values are partial or blank", async () => {
    for (const projectLayer of [
      { provider: "hidden" },
      { provider: "hidden", model: "   " },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "safe-allow-layer-pair-"));
      temporaryRoots.push(root);
      const cwd = join(root, "repo");
      const agentDir = join(root, "agent");
      const projectPath = getProjectConfigPath(cwd);
      const globalPath = getGlobalConfigPath(agentDir);
      mkdirSync(dirname(projectPath), { recursive: true });
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(projectPath, JSON.stringify(projectLayer));
      writeFileSync(
        globalPath,
        JSON.stringify(selectedReference),
      );
      const fixture = harness({ configRoot: root });
      await start(fixture);

      await fixture.commands.get("review-model")!.handler("show", fixture.ctx);

      expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
        `${selectedRef}; source: Global`,
      );
    }
  });

  it("rolls back exact persistent bytes when Session persistence fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-rollback-"));
    temporaryRoots.push(root);
    const projectPath = getProjectConfigPath(join(root, "repo"));
    const originalBytes = "{\n  \"timeoutMs\": 4321\n}";
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, originalBytes);
    const fixture = harness({ configRoot: root });
    await start(fixture);
    await fixture.commands.get("review-model")!.handler(
      "missing/reviewer --project",
      fixture.ctx,
    );
    expect(readFileSync(projectPath, "utf8")).toBe(originalBytes);
    expect(fixture.appendEntry).not.toHaveBeenCalled();

    fixture.appendEntry.mockImplementationOnce(() => {
      throw new Error("session file unavailable");
    });

    await fixture.commands.get("review-model")!.handler(
      `${selectedRef} --project`,
      fixture.ctx,
    );

    expect(readFileSync(projectPath, "utf8")).toBe(originalBytes);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      "Session state could not be persisted",
    );
  });
  it("refuses corrupt and non-object targets without changing bytes or Session", async () => {
    for (const badBytes of ["{ not json", "[]"]) {
      const root = mkdtempSync(join(tmpdir(), "safe-allow-corrupt-"));
      temporaryRoots.push(root);
      const projectPath = getProjectConfigPath(join(root, "repo"));
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(projectPath, badBytes);
      const fixture = harness({ configRoot: root });
      await start(fixture);

      await fixture.commands.get("review-model")!.handler(
        `${selectedRef} --project`,
        fixture.ctx,
      );

      expect(readFileSync(projectPath, "utf8")).toBe(badBytes);
      expect(fixture.appendEntry).not.toHaveBeenCalled();
      const message = fixture.notify.mock.calls.at(-1)![0];
      expect(message).toContain("Project reviewer configuration");
      expect(message).toContain(projectPath);
      expect(message).toMatch(/malformed JSON|expected a JSON object/);

      await fixture.commands.get("review-model")!.handler(
        "reset --project",
        fixture.ctx,
      );
      expect(readFileSync(projectPath, "utf8")).toBe(badBytes);
      expect(fixture.appendEntry).not.toHaveBeenCalled();
      expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
        "Project reviewer configuration",
      );
    }
  });

  it("reports atomic write failures with scope and path and leaves Session unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-write-failure-"));
    temporaryRoots.push(root);
    const blockingParent = join(
      root,
      "agent",
      "extensions",
      "pi-permission-safe-allow",
    );
    mkdirSync(dirname(blockingParent), { recursive: true });
    writeFileSync(blockingParent, "not a directory");
    const fixture = harness({ configRoot: root });
    await start(fixture);

    await fixture.commands.get("review-model")!.handler(
      `${selectedRef} --global`,
      fixture.ctx,
    );

    expect(fixture.appendEntry).not.toHaveBeenCalled();
    const message = fixture.notify.mock.calls.at(-1)![0];
    expect(message).toContain("Global reviewer configuration");
    expect(message).toContain(getGlobalConfigPath(join(root, "agent")));
    expect(message).toContain("write failed");
  });
});
