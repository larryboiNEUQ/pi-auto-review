import type { PermissionQuery } from "#src/service";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFE_ALLOW_EXTENSION_ID, withDefaults } from "#safe/config-schema";
import { buildApprovalDossier } from "#safe/dossier";
import { reviewDossier, type CompleteFn } from "#safe/model-review";
import { executeReviewer } from "#safe/reviewer-backend";
import { DenialLifecycle } from "#safe/denial-lifecycle";
import { createSafeAllowReviewer } from "#safe/safe-allow-reviewer";
import { evaluateJevViaOfficial } from "#safe/jev-evaluation";
import { makeDetails } from "#test/fixtures";

const secret = "opaque-private-value HTTP 429 Authorization: Bearer adversarial";
const model = { contextWindow: 128_000, maxTokens: 4_096 } as Model<"openai-responses">;
const backend = { kind: "chat" as const, provider: "fixture", id: "m", model };
const config = withDefaults({ timeoutMs: 2000, maxAttempts: 3, investigationEnabled: false });
const registry = { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true as const }) };
const evidence = [{ role: "user", content: "Inspect the repository." }];
const dossier = buildApprovalDossier({ details: makeDetails(), evidence })!;
function reply(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", stopReason, errorMessage: secret, timestamp: 1,
    content: [{ type: "text", text: JSON.stringify({ riskLevel: "low", userAuthorization: "high", verdict: "allow", rationale: "ok", scope: "narrow", absoluteDeny: false }) }],
  } as AssistantMessage;
}
function inputs(complete: CompleteFn) { return { dossier, config, backend, registry, complete }; }

describe("bounded reviewer diagnostics", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "review-diagnostics-")); vi.stubEnv("PI_CODING_AGENT_DIR", root); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
  function records() {
    return readFileSync(join(root, "extensions", SAFE_ALLOW_EXTENSION_ID, "logs", "safe-allow.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
  }
  it("retains observed error diagnostics through three retries and the final real JSONL audit", async () => {
    const complete = vi.fn<CompleteFn>(async () => reply("error"));
    const reviewer = createSafeAllowReviewer({ getConfig: () => config, getRegistry: () => registry,
      getEvidence: () => evidence, getSignal: () => undefined, getBatchProvenance: () => "single",
      lifecycle: new DenialLifecycle(), complete });
    const query = { checkPermission: vi.fn(), getToolPermission: vi.fn(), resolveTarget: vi.fn() } as unknown as PermissionQuery;
    const result = await reviewer(makeDetails(), query);
    expect(result).toMatchObject({ kind: "unavailable", code: "model" });
    expect(complete).toHaveBeenCalledTimes(3);
    const logs = records();
    const retries = logs.filter((r) => r.event === "review.retry");
    expect(retries.map((r) => r.diagnostic)).toEqual([1, 2, 3].map((attempt) => ({
      source: "chat", classification: "model", stopReason: "error", attempt,
      provider: "fixture", model: "m", backend: "chat", durationMs: expect.any(Number),
    })));
    expect(logs.find((r) => r.event === "review.failure")).toMatchObject({
      code: "model", attempts: 3, diagnostic: retries[2].diagnostic,
    });
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
  it("keeps the recovery attempt diagnostic in an injected audit", async () => {
    const audit = vi.fn(() => true);
    const complete = vi.fn<CompleteFn>().mockResolvedValueOnce(reply("error")).mockResolvedValue(reply("stop"));
    const outcome = await reviewDossier({ ...inputs(complete), audit });
    expect(outcome).toMatchObject({ kind: "reviewed", attempts: 2 });
    expect(audit).toHaveBeenCalledWith("review.retry", expect.objectContaining({
      diagnostic: expect.objectContaining({ stopReason: "error", attempt: 1, classification: "model" }),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(secret);
  });
  it("distinguishes provider-aborted replies from caller cancellation and deadline expiry", async () => {
    const audit = vi.fn(() => true);
    const aborted = await reviewDossier({ ...inputs(async () => reply("aborted")), audit });
    expect(aborted).toMatchObject({ kind: "failure", code: "model", attempts: 3,
      diagnostic: { source: "chat", classification: "model", stopReason: "aborted", attempt: 3 } });
    const controller = new AbortController();
    const cancelled = await reviewDossier({ ...inputs(async () => { controller.abort(); return reply("aborted"); }), signal: controller.signal, audit });
    expect(cancelled).toMatchObject({ kind: "failure", code: "cancelled", attempts: 1,
      diagnostic: { classification: "cancelled", source: "review" } });
    const timed = await reviewDossier({ ...inputs(async () => new Promise(() => undefined)), config: { ...config, timeoutMs: 10 }, audit });
    expect(timed).toMatchObject({ kind: "failure", code: "timeout", attempts: 1,
      diagnostic: { classification: "timeout", source: "review" } });
    expect(cancelled).not.toHaveProperty("diagnostic.stopReason");
    expect(timed).not.toHaveProperty("diagnostic.stopReason");
  });
  it.each([503, undefined, "429", NaN, 999])("copies only actual structured HTTP status %s", async (statusCode) => {
    const outcome = await reviewDossier({ ...inputs(async () => { throw Object.assign(new Error(secret), { statusCode, headers: { authorization: secret }, body: secret }); }), audit: () => true });
    expect(outcome).toMatchObject({ kind: "failure", code: "transport", attempts: 3,
      diagnostic: { classification: "transport", source: "chat", attempt: 3 } });
    if (statusCode === 503) expect(outcome).toHaveProperty("diagnostic.httpStatus", 503);
    else expect(outcome).not.toHaveProperty("diagnostic.httpStatus");
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
  it("reports parse and authentication locally without copying external data", async () => {
    const parse = await reviewDossier({ ...inputs(async () => ({ ...reply("stop"), content: [{ type: "text", text: secret }] })), audit: () => true });
    expect(parse).toMatchObject({ kind: "failure", code: "parse", attempts: 3, diagnostic: { classification: "parse", source: "chat" } });
    const auth = await reviewDossier({ ...inputs(async () => reply("stop")), registry: { ...registry, getApiKeyAndHeaders: async () => { throw new Error(secret); } } });
    expect(auth).toMatchObject({ kind: "failure", code: "auth", attempts: 0, diagnostic: { classification: "auth", source: "authentication" } });
    expect(JSON.stringify([parse, auth])).not.toContain(secret);
  });
  it.each([false, "throw"])("fails closed when retry audit fails with %s", async (mode) => {
    const complete = vi.fn<CompleteFn>().mockResolvedValueOnce(reply("error")).mockResolvedValue(reply("stop"));
    const outcome = await reviewDossier({ ...inputs(complete), audit: () => { if (mode === "throw") throw new Error(secret); return false; } });
    expect(outcome).toMatchObject({ kind: "failure", code: "audit", attempts: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
  it("uses a fixed backend error message instead of the provider message", async () => {
    await expect(executeReviewer({ ...inputs(async () => reply("error")), auth: { ok: true }, signal: new AbortController().signal }))
      .rejects.toMatchObject({ message: "Reviewer session failed.", diagnostic: { source: "chat", classification: "model", stopReason: "error" } });
  });
  it("retains official Jev response status without changing the evaluation contract", async () => {
    const outcome = await reviewDossier({ ...inputs(vi.fn()),
      backend: { kind: "evaluation", provider: "vercel-ai-gateway", id: "typesafe-ai/jev", contractVersion: "guardian-jev-v3" },
      jevResolution: { transport: "official", typesafeApiKey: "fixture-key" },
      evaluate: (request) => evaluateJevViaOfficial({ ...request, fetchImpl: async () => new Response(secret, { status: 401 }) }), audit: () => true });
    expect(outcome).toMatchObject({ kind: "failure", code: "transport", attempts: 3,
      diagnostic: { source: "evaluation", classification: "transport", httpStatus: 401 } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});
