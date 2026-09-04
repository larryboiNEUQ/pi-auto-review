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
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  publishPermissionsService,
  unpublishPermissionsService,
  type PermissionsService,
} from "@gotgenes/pi-permission-system";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("safe-allow extension integration", () => {
  let published: PermissionsService | undefined;
  const temporaryRoots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
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
    const namespaced = model("gateway", "team/reviewer-v2");
    const hidden = model("hidden", "reviewer");
    const models = [base, namespaced, hidden];
    const auth = vi.fn().mockResolvedValue({ ok: true });
    const registry = {
      find: vi.fn((provider: string, id: string) =>
        models.find((candidate) => candidate.provider === provider && candidate.id === id),
      ),
      getAvailable: vi.fn(() => models),
      getApiKeyAndHeaders: auth,
    };
    const complete = vi.fn().mockResolvedValue(reviewerReply());

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
    });

    const notify = vi.fn();
    const select = vi.fn();
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
      ui: { notify, select },
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
      complete,
      ctx,
      notify,
      select,
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
      "gateway/team/reviewer-v2",
      fixture.ctx,
    );

    expect(fixture.auth).toHaveBeenCalledWith(fixture.namespaced);
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.appendEntry).toHaveBeenCalledWith(
      REVIEWER_MODEL_SESSION_ENTRY,
      {
        version: 1,
        selection: { provider: "gateway", model: "team/reviewer-v2" },
      },
    );
    expect(fixture.registered).toHaveBeenCalledTimes(1);

    const outcome = await reviewer(makeDetails(), {
      checkPermission: vi.fn(),
      getToolPermission: vi.fn(),
      resolveTarget: vi.fn(),
    });
    expect(outcome).toEqual({ kind: "allow" });
    expect(fixture.complete.mock.calls[0]![0]).toBe(fixture.namespaced);
  });

  it("uses Pi's scoped model set for the reviewer picker and cancellation is inert", async () => {
    const fixture = harness();
    (fixture.ctx as any).scopedModels = [
      { model: fixture.base },
      { model: fixture.namespaced },
    ];
    await start(fixture);
    const command = fixture.commands.get("review-model")!;

    fixture.select.mockResolvedValueOnce(undefined);
    await command.handler("", fixture.ctx);
    expect(fixture.select).toHaveBeenCalledWith(
      "Safe-allow reviewer model (independent from Pi /model)",
      [
        "gateway/team/reviewer-v2",
        "openai-codex/gpt-5.4-mini (current reviewer)",
      ],
    );
    expect(fixture.appendEntry).not.toHaveBeenCalled();

    fixture.select
      .mockResolvedValueOnce("gateway/team/reviewer-v2")
      .mockResolvedValueOnce(undefined);
    await command.handler("", fixture.ctx);
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.select).toHaveBeenCalledWith(
      "Apply reviewer model to which scope?",
      ["Session (default)", "Project", "Global"],
    );

    fixture.select
      .mockResolvedValueOnce("gateway/team/reviewer-v2")
      .mockResolvedValueOnce("Session (default)");
    await command.handler("", fixture.ctx);
    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, out-of-scope, and unauthenticated switches atomically", async () => {
    const fixture = harness();
    (fixture.ctx as any).scopedModels = [
      { model: fixture.base },
      { model: fixture.namespaced },
    ];
    await start(fixture);
    const command = fixture.commands.get("review-model")!;

    await command.handler("gateway/team/reviewer-v2", fixture.ctx);
    await command.handler("gateway", fixture.ctx);
    await command.handler("hidden/reviewer", fixture.ctx);
    fixture.auth.mockResolvedValueOnce({ ok: false, error: "secret credential detail" });
    await command.handler("openai-codex/gpt-5.4-mini", fixture.ctx);
    fixture.auth.mockRejectedValueOnce(new Error("secret auth backend failure"));
    await command.handler("openai-codex/gpt-5.4-mini", fixture.ctx);

    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
    await command.handler("show", fixture.ctx);
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      "gateway/team/reviewer-v2; source: Session",
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

    await command.handler("gateway/team/reviewer-v2", fixture.ctx);
    fixture.auth.mockResolvedValueOnce({
      ok: false,
      error: "token sk-do-not-display",
    });
    await command.handler("show", fixture.ctx);
    expect(fixture.notify).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "gateway/team/reviewer-v2; source: Session; validation: invalid",
      ),
      "warning",
    );
    expect(fixture.notify.mock.calls.at(-1)![0]).not.toContain("sk-do-not-display");
  });

  it("reset clears only Session state and immediately restores the configured reviewer", async () => {
    const fixture = harness();
    await start(fixture);
    const command = fixture.commands.get("review-model")!;
    await command.handler("gateway/team/reviewer-v2", fixture.ctx);
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
    await command.handler("gateway/team/reviewer-v2", fixture.ctx);

    for (const reason of ["reload", "resume"]) {
      await shutdown(fixture);
      await start(fixture, reason);
      await command.handler("show", fixture.ctx);
      expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
        "gateway/team/reviewer-v2; source: Session",
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

  it("inherits the source Session reviewer for fork and clone lifecycle starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "safe-allow-fork-"));
    temporaryRoots.push(root);
    const sourceSession = join(root, "source.jsonl");
    writeFileSync(
      sourceSession,
      [
        JSON.stringify({ type: "session", id: "source" }),
        JSON.stringify({
          type: "custom",
          customType: REVIEWER_MODEL_SESSION_ENTRY,
          data: {
            version: 1,
            selection: { provider: "gateway", model: "team/reviewer-v2" },
          },
        }),
      ].join("\n"),
    );

    for (const position of ["fork", "clone"]) {
      const fixture = harness();
      await start(fixture, "fork", sourceSession);
      await fixture.commands.get("review-model")!.handler("show", fixture.ctx);
      expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
        "gateway/team/reviewer-v2; source: Session",
      );
      expect(fixture.appendEntry).toHaveBeenCalledWith(
        REVIEWER_MODEL_SESSION_ENTRY,
        expect.objectContaining({
          selection: { provider: "gateway", model: "team/reviewer-v2" },
        }),
      );
      await shutdown(fixture);
      expect(position).toMatch(/fork|clone/);
    }
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
    await command.handler("gateway/team/reviewer-v2 --global", fixture.ctx);

    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
      provider: "gateway",
      model: "team/reviewer-v2",
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
    expect(fixture.complete.mock.calls.at(-1)![0]).toBe(fixture.namespaced);

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
      "gateway/team/reviewer-v2 (Global)",
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
    fixture.select
      .mockResolvedValueOnce("gateway/team/reviewer-v2")
      .mockResolvedValueOnce("Project");

    await fixture.commands.get("review-model")!.handler("", fixture.ctx);

    expect(JSON.parse(readFileSync(getProjectConfigPath(join(root, "repo")), "utf8")))
      .toEqual({ provider: "gateway", model: "team/reviewer-v2" });
    expect(fixture.notify.mock.calls.at(-1)![0]).toContain(
      "Project reviewer model switched",
    );
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
      "gateway/team/reviewer-v2 --project",
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
        "gateway/team/reviewer-v2 --project",
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
      "gateway/team/reviewer-v2 --global",
      fixture.ctx,
    );

    expect(fixture.appendEntry).not.toHaveBeenCalled();
    const message = fixture.notify.mock.calls.at(-1)![0];
    expect(message).toContain("Global reviewer configuration");
    expect(message).toContain(getGlobalConfigPath(join(root, "agent")));
    expect(message).toContain("write failed");
  });
});
