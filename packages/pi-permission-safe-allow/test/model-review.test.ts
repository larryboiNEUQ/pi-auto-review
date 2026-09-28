import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { withDefaults } from "#safe/config-schema";
import { buildApprovalDossier } from "#safe/dossier";
import { JEV_QUESTIONS } from "#safe/jev-evaluation";
import { reviewDossier, type ModelRegistryLike } from "#safe/model-review";
import { reportedUsage } from "#safe/reviewer-backend";
import { makeDetails } from "#test/fixtures";

const registry = {
  find: () => undefined,
  getApiKeyAndHeaders: async () => ({ ok: true }),
  getApiKeyForProvider: async () => "gateway-key",
} as ModelRegistryLike;

function dossier() {
  const built = buildApprovalDossier({
    details: makeDetails(),
    evidence: [{ role: "user", content: "Inspect the repository." }],
  });
  if (!built) throw new Error("dossier");
  return built;
}

function answers() {
  return Object.fromEntries(Object.entries(JEV_QUESTIONS).map(([id, question]) => {
    const choice = Object.keys(question.criteria)[0]!;
    return [id, { type: "choice", choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])) }];
  }));
}

describe("reviewDossier currentness and usage", () => {
  it("returns authorization_changed when isCurrent fails before inference", async () => {
    const complete = vi.fn();
    const outcome = await reviewDossier({
      dossier: dossier(),
      config: withDefaults({ timeoutMs: 2000, maxAttempts: 1 }),
      backend: { kind: "chat", provider: "fixture", id: "m", model: { contextWindow: 128_000, maxTokens: 4_096 } as never },
      registry,
      complete,
      isCurrent: () => false,
    });
    expect(outcome).toMatchObject({ kind: "failure", code: "authorization_changed" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps an admission failure as evidence", async () => {
    const complete = vi.fn();
    const compacted = buildApprovalDossier({
      details: makeDetails(),
      evidence: [{ type: "compaction", summary: "earlier grant omitted" }, { role: "user", content: "continue" }],
    });
    const outcome = await reviewDossier({
      dossier: compacted!,
      config: withDefaults({ timeoutMs: 2000, maxAttempts: 1 }),
      backend: { kind: "chat", provider: "fixture", id: "m", model: { contextWindow: 128_000, maxTokens: 4_096 } as never },
      registry,
      complete,
      isCurrent: () => true,
    });
    expect(outcome).toMatchObject({ kind: "failure", code: "evidence" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("copies provider usage when present and omits it when absent", async () => {
    expect(reportedUsage(undefined)).toBeUndefined();
    expect(reportedUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(reportedUsage({})).toBeUndefined();

    const config = withDefaults({ timeoutMs: 2000, maxAttempts: 1 });
    const backend = { kind: "chat" as const, provider: "fixture", id: "m", model: { contextWindow: 128_000, maxTokens: 4_096 } as never };
    const present = await reviewDossier({
      dossier: dossier(), config, backend, registry,
      complete: async () => ({
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ riskLevel: "low", userAuthorization: "high", verdict: "allow", rationale: "ok", scope: "narrow", absoluteDeny: false }) }],
        stopReason: "stop",
        timestamp: 1,
        usage: { input: 4, output: 2 },
      }) as AssistantMessage,
    });
    expect(present).toMatchObject({ kind: "reviewed", usage: { input: 4, output: 2 } });

    const absent = await reviewDossier({
      dossier: dossier(), config, backend, registry,
      complete: async () => ({
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ riskLevel: "low", userAuthorization: "high", verdict: "allow", rationale: "ok", scope: "narrow", absoluteDeny: false }) }],
        stopReason: "stop",
        timestamp: 1,
      }) as AssistantMessage,
    });
    expect(absent.kind).toBe("reviewed");
    expect(absent).not.toHaveProperty("usage");
  });

  it("records evaluation usage only from the provider payload", async () => {
    vi.stubEnv("SAFE_ALLOW_JEV_TRANSPORT", "gateway");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const config = withDefaults({ timeoutMs: 2000, maxAttempts: 1 });
    const backend = { kind: "evaluation" as const, provider: "vercel-ai-gateway", id: "typesafe-ai/jev", contractVersion: "guardian-jev-v3" };
    const present = await reviewDossier({
      dossier: dossier(), config, backend, registry,
      complete: vi.fn(),
      evaluate: async () => ({ answers: answers(), usage: { input_tokens: 10, output_tokens: 5 } }),
    });
    expect(present).toMatchObject({ kind: "reviewed", usage: { input_tokens: 10, output_tokens: 5 } });
    const absent = await reviewDossier({
      dossier: dossier(), config, backend, registry,
      complete: vi.fn(),
      evaluate: async () => ({ answers: answers() }),
    });
    expect(absent.kind).toBe("reviewed");
    expect(absent).not.toHaveProperty("usage");
    vi.unstubAllEnvs();
  });
});
