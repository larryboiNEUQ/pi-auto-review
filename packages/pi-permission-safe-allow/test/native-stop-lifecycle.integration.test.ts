import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publishPermissionsService, unpublishPermissionsService, type PermissionsService } from "@gotgenes/pi-permission-system";
import { expect, it, vi } from "vitest";

import { withDefaults } from "#safe/config-schema";
import { createSafeAllowExtension } from "#safe/extension";
import { makeDetails, makeFacts } from "#test/fixtures";

// The project SDK is intentionally older than the supported native host.
// Enable this test only with the separately installed native runtime.
const nativeRoot = process.env.PI_AUTO_REVIEW_TEST_HOST_ROOT;
it.skipIf(!nativeRoot)("native stopping notice waits for agent_settled, after agent_end becomes idle", async () => {
  const host = await import(/* @vite-ignore */ pathToFileURL(join(nativeRoot!, "dist/index.js")).href);
  const root = mkdtempSync(join(tmpdir(), "safe-allow-native-stop-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const observations: Array<{ event: string; idle: boolean }> = [];
  const errors: unknown[] = [];
  const registered = vi.fn().mockReturnValue(() => undefined);
  const service = { registerAuthorizer: registered } as unknown as PermissionsService;
  publishPermissionsService(service);
  let session: any;
  try {
    const runtime = await host.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("native-stop-fixture", {
      baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "disposable-fixture-key",
      models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4_096 }],
    });
    const model = runtime.getModel("native-stop-fixture", "fixture");
    const complete = vi.fn().mockResolvedValue({ role: "assistant", stopReason: "stop", timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify({ riskLevel: "critical", userAuthorization: "unknown",
        verdict: "deny", rationale: "Controlled hard refusal.", scope: "narrow", absoluteDeny: true }) }],
    });
    const settings = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new host.DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [(pi: ExtensionAPI) => {
        createSafeAllowExtension(pi, {
          loadConfig: () => ({ config: withDefaults({ provider: model.provider, model: model.id }), issues: [] }),
          getBatchProvenance: () => "single", complete,
        });
        pi.on("agent_end", (_event, ctx) => {
          observations.push({ event: "agent_end", idle: ctx.isIdle() });
        });
        pi.on("agent_settled", (_event, ctx) => {
          observations.push({ event: "agent_settled", idle: ctx.isIdle() });
        });
        pi.registerTool({ name: "review_fixture", label: "Review fixture", description: "Return an actual reviewer result without side effects",
          parameters: { type: "object", properties: {}, additionalProperties: false } as any,
          execute: async (toolCallId: string) => {
            // One native turn can contain several independent live-authority asks.
            // Keep this fixture effect-free while exercising the actual reviewer breaker.
            const results = [];
            for (let i = 0; i < 3; i++) {
              const details = makeDetails(makeFacts({ requestId: `${toolCallId}-${i}`, exactActionId: `${toolCallId}-${i}-action` }));
              details.toolCallId = toolCallId;
              results.push(await registered.mock.calls[0]![1](details, {
                checkPermission: vi.fn(), getToolPermission: vi.fn(), resolveTarget: vi.fn(),
              }));
            }
            return { content: [{ type: "text", text: JSON.stringify(results) }], details: {} };
          },
        });
      }],
    });
    await loader.reload();
    ({ session } = await host.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
      resourceLoader: loader, settingsManager: settings, sessionManager: host.SessionManager.inMemory(root), tools: ["review_fixture"] }));
    let requests = 0;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: requests < 1 ? "toolUse" : "stop",
        content: requests < 1 ? [{ type: "toolCall", id: `local-${requests++}`, name: "review_fixture", arguments: {} }]
          : [{ type: "text", text: "Finished." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
      return stream;
    };
    const notify = vi.fn(() => {
      observations.push({ event: "stop_notice", idle: session.isIdle });
    });
    await session.bindExtensions({ mode: "interactive", uiContext: { notify }, onError: (error: unknown) => errors.push(error) });
    await session.prompt("Run the harmless refusal fixture.");
    await session.waitForIdle();

    expect(errors).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(observations).toEqual([
      { event: "agent_end", idle: false },
      { event: "stop_notice", idle: true },
      { event: "agent_settled", idle: true },
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(session.isIdle).toBe(true);
  } finally {
    session?.dispose();
    unpublishPermissionsService(service);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
