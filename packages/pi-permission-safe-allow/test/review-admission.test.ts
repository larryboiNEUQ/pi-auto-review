import { describe, expect, it } from "vitest";
import { withDefaults } from "../src/config-schema";
import type { ApprovalDossier } from "../src/dossier";
import { admitReviewerRequest, estimateReviewerRequestTokens, requestLimitTokens, jevReviewer, type ReviewerBackend } from "../src/reviewer-backend";

function dossier(overrides: Partial<ApprovalDossier> = {}): ApprovalDossier {
  return {
    schemaVersion: 1,
    evidenceContractVersion: "bounded-provenance-v2",
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
  it.each([model(25_000), jevReviewer])("marks hard truncation of even the latest historical user, including the accepted middle-loss boundary", (backend) => {
    const middle = "MIDDLE: Do not publish.";
    const tail = "TAIL: Do not publish.";
    const input = dossier({ evidence: [
      { category: "user", role: "user", provenance: "host-user", truncated: false, text: "You may publish." },
      { category: "user", role: "user", provenance: "host-user", truncated: false, text: `HEAD ${"汉🙂".repeat(25_000)} ${middle} ${"汉🙂".repeat(25_000)} ${tail}` },
    ] });
    const result = admitReviewerRequest(config, backend, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const latest = result.dossier.evidence.filter((entry) => entry.provenance === "host-user").at(-1)!;
    expect(latest.truncated).toBe(true);
    expect(latest.text.startsWith("HEAD ")).toBe(true);
    expect(latest.text.endsWith(tail)).toBe(true);
    expect(latest.text).not.toContain(middle);
    expect(latest.text).toContain('<truncated omitted_approx_tokens="');
    expect(latest.text).not.toContain("\uFFFD");
    expect(latest.text.isWellFormed()).toBe(true);
    expect(result.dossier.evidence[0]!.text).toBe("You may publish.");
    expect(estimateReviewerRequestTokens(config, backend, result.dossier)).toBeLessThanOrEqual(requestLimitTokens(backend)!);
    expect(admitReviewerRequest(config, backend, input)).toEqual(result);
  });

  it("never recovers by shortening system instructions even when users can be shortened", () => {
    const input = dossier({ evidence: [
      { category: "user", role: "user", provenance: "host-user", truncated: false, text: "history ".repeat(20_000) },
      { category: "system", role: "system", provenance: "system", truncated: false, text: "Required instruction ".repeat(2000) },
    ] });
    const before = JSON.stringify(input);
    expect(admitReviewerRequest(config, model(12_000), input)).toMatchObject({ ok: false });
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([model(12_000), jevReviewer])("recovers oldest historical users after optional pairs while retaining the latest restriction", (backend) => {
    const old = `OLD START ${"reference notes ".repeat(6000)} OLD END`;
    const revoke = "STOP: I revoke authorization to publish. Do not publish.";
    const input = dossier({ evidence: [
      { category: "tool_call", role: "assistant", provenance: "assistant", callId: "pair", truncated: false, text: "optional call" },
      { category: "tool_result", role: "tool", provenance: "tool-fact", callId: "pair", truncated: false, text: "optional result" },
      { category: "user", role: "user", provenance: "host-user", truncated: false, text: old },
      { category: "user", role: "user", provenance: "host-user", truncated: false, text: revoke },
    ] });
    const snapshot = JSON.stringify(input);
    const result = admitReviewerRequest(config, backend, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dossier.evidence.some((entry) => entry.callId === "pair")).toBe(false);
    const users = result.dossier.evidence.filter((entry) => entry.provenance === "host-user");
    expect(users[0]).toMatchObject({ truncated: true, text: expect.stringContaining('<truncated omitted_approx_tokens="') });
    expect(users[0]!.text.startsWith("OLD START ")).toBe(true);
    expect(users[0]!.text.endsWith(" OLD END")).toBe(true);
    expect(users[1]).toMatchObject({ text: revoke, truncated: false });
    expect(result.dossier.evidenceDiagnostics.omissionCounts.review_request_budget).toBe(2);
    expect(result.dossier.evidenceDiagnostics.omissionCounts.review_request_history_truncation).toBe(1);
    expect(result.dossier.evidenceDiagnostics.truncatedEntries).toBe(1);
    expect(estimateReviewerRequestTokens(config, backend, result.dossier)).toBeLessThanOrEqual(requestLimitTokens(backend)!);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

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

  it("admits unsupported user content as a marked omission (Codex parity: signal, never deadlock)", () => {
    const input = dossier({ evidenceDiagnostics: { ...dossier().evidenceDiagnostics, omittedEntries: 1, omissionCounts: { user_unsupported_content: 1 }, omissionReasons: ["user_unsupported_content"] } });
    expect(admitReviewerRequest(config, model(100_000), input)).toMatchObject({ ok: true });
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


  it("admits compacted user history as a marked omission instead of failing closed", () => {
    const input = dossier({ evidenceDiagnostics: { ...dossier().evidenceDiagnostics, omittedEntries: 1, omissionCounts: { compacted_user_history: 1 }, omissionReasons: ["compacted_user_history"] } });
    expect(admitReviewerRequest(config, model(100_000), input)).toMatchObject({ ok: true });
  });


  it("uses a fixed Jev request cap without claiming a provider context window", () => {
    expect(admitReviewerRequest(config, jevReviewer, dossier({ action: { ...dossier().action, value: "x".repeat(80_000) } as unknown as ApprovalDossier["action"] }))).toMatchObject({ ok: false, reason: expect.stringContaining("Mandatory") });
  });
});
