import { describe, expect, it } from "vitest";
import { withDefaults } from "../src/config-schema";
import type { ApprovalDossier } from "../src/dossier";
import { admitReviewerRequest, jevReviewer, type ReviewerBackend } from "../src/reviewer-backend";

function dossier(overrides: Partial<ApprovalDossier> = {}): ApprovalDossier {
  return {
    schemaVersion: 1,
    evidenceContractVersion: "bounded-provenance-v1",
    request: { id: "request", source: "tool_call", agentName: null },
    action: { complete: true, missing: [], exactActionId: "action", surface: "bash", action: { command: "echo ok" }, policy: { state: "ask" } } as unknown as ApprovalDossier["action"],
    agentJustification: "",
    evidence: [],
    evidenceDiagnostics: { omittedEntries: 0, truncatedEntries: 0, toolResultsIncluded: false, omissionReasons: [], omissionCounts: {} },
    probeEvidence: [], override: null,
    limitations: { osSandboxPresent: false, statement: "" },
    ...overrides,
  };
}
const config = withDefaults({});
const model = (contextWindow?: number, maxTokens = 1000) => ({ kind: "chat" as const, provider: "test", id: "test", model: { contextWindow, maxTokens } as never }) satisfies ReviewerBackend;

describe("review request admission", () => {
  it("fails closed when chat model context limit is missing", () => {
    expect(admitReviewerRequest(config, model(undefined), dossier())).toMatchObject({ ok: false, reason: expect.stringContaining("context limit") });
  });

  it("rejects an oversized mandatory action without trimming it", () => {
    const input = dossier({ action: { ...dossier().action, value: "x".repeat(30_000) } as unknown as ApprovalDossier["action"] });
    const result = admitReviewerRequest(config, model(3000), input);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("Mandatory") });
  });

  it("trims optional old non-user evidence, records why, and marks the sent dossier", () => {
    const input = dossier({ evidence: [
      { category: "assistant", role: "assistant", provenance: "assistant", truncated: false, text: "old optional history ".repeat(2000) },
      { category: "user", role: "user", provenance: "host-user", truncated: false, text: "current user instruction" },
    ] });
    const result = admitReviewerRequest(config, model(12_000), input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dossier.evidenceDiagnostics.omissionCounts.review_request_budget).toBeGreaterThan(0);
    expect(result.dossier.evidence.some((entry) => entry.text.includes("omitted older optional non-user evidence"))).toBe(true);
    expect(result.dossier.evidence.some((entry) => entry.text === "current user instruction")).toBe(true);
  });

  it("does not restore opt-out tool history", () => {
    const input = dossier({ evidence: [], evidenceDiagnostics: { omittedEntries: 1, truncatedEntries: 0, toolResultsIncluded: false, omissionReasons: ["tool_results_opted_out"], omissionCounts: { tool_results_opted_out: 1 } } });
    const result = admitReviewerRequest(config, model(100_000), input);
    expect(result).toMatchObject({ ok: true, dossier: { evidence: [] } });
  });

  it("blocks non-ASCII mandatory input instead of treating CJK as four characters per token", () => {
    const input = dossier({ action: { ...dossier().action, value: "汉".repeat(14_000) } as unknown as ApprovalDossier["action"] });
    expect(admitReviewerRequest(config, model(8_192), input)).toMatchObject({ ok: false, reason: expect.stringContaining("Mandatory") });
  });

  it("blocks unsupported user content instead of silently losing a restriction", () => {
    const input = dossier({ evidenceDiagnostics: { ...dossier().evidenceDiagnostics, omittedEntries: 1, omissionCounts: { user_unsupported_content: 1 }, omissionReasons: ["user_unsupported_content"] } });
    expect(admitReviewerRequest(config, model(100_000), input)).toMatchObject({ ok: false, reason: expect.stringContaining("mandatory user/system") });
  });

  it("removes a call and its result together under admission pressure", () => {
    const input = dossier({ evidence: [
      { category: "tool_call", role: "assistant", provenance: "assistant", callId: "pair-1", truncated: false, text: "old call ".repeat(1800) },
      { category: "tool_result", role: "tool", provenance: "tool-fact", callId: "pair-1", truncated: false, text: "result detail" },
      { category: "user", role: "user", provenance: "host-user", truncated: false, text: "Continue." },
    ] });
    const result = admitReviewerRequest(config, model(12_000), input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dossier.evidence.some((entry) => entry.callId === "pair-1")).toBe(false);
    expect(result.dossier.evidenceDiagnostics.omissionCounts.review_request_budget).toBe(2);
  });


  it("blocks compacted user history when active-branch ancestry is incomplete", () => {
    const input = dossier({ evidenceDiagnostics: { ...dossier().evidenceDiagnostics, omittedEntries: 1, omissionCounts: { compacted_user_history: 1 }, omissionReasons: ["compacted_user_history"] } });
    expect(admitReviewerRequest(config, model(100_000), input)).toMatchObject({ ok: false, reason: expect.stringContaining("mandatory user/system") });
  });


  it("uses a fixed Jev request cap without claiming a provider context window", () => {
    expect(admitReviewerRequest(config, jevReviewer, dossier({ action: { ...dossier().action, value: "x".repeat(80_000) } as unknown as ApprovalDossier["action"] }))).toMatchObject({ ok: false, reason: expect.stringContaining("Mandatory") });
  });
});
