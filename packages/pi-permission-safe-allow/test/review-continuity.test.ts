import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { withDefaults } from "#safe/config-schema";
import { admitReviewerRequest, estimateReviewerRequestTokens, jevReviewer, type ReviewerBackend } from "#safe/reviewer-backend";
import { ReviewerContinuity } from "#safe/review-continuity";
import { buildApprovalDossier, type ApprovalDossier } from "#safe/dossier";
import { makeDetails, makeFacts } from "#test/fixtures";

const backend: ReviewerBackend = { kind: "chat", provider: "test", id: "reviewer", model: {
  provider: "test", id: "reviewer", contextWindow: 128_000, maxTokens: 4_096,
} as Model<any> };
const config = withDefaults({});
function dossier(action = "first", entries: readonly unknown[] = [
  { type: "message", id: "u1", message: { role: "user", content: "Inspect the repository." } },
]): ApprovalDossier {
  const details = makeDetails(makeFacts({ requestId: `request-${action}`, exactActionId: `action-${action}` }));
  const built = buildApprovalDossier({ details, evidence: entries, evidencePolicy: { includeToolResults: true, ownerSessionId: "owner" } });
  expect(built).not.toBeNull();
  const admission = admitReviewerRequest(config, backend, built!);
  expect(admission.ok).toBe(true);
  return admission.ok ? admission.dossier : built!;
}
function text(review: ReturnType<ReviewerContinuity["prepare"]>): string {
  return review.context?.messages.map((m) => String(m.content)).join("\n") ?? "";
}

describe("bounded reviewer continuity", () => {
  it("captures a full first request and a current-only delta when the host branch and evidence prefix validate", () => {
    const store = new ReviewerContinuity();
    const first = store.prepare({ ownerSessionId: "owner", branchIds: ["u1"], config, backend, dossier: dossier("first") });
    expect(first).toMatchObject({ mode: "full", reason: "new-session" });
    expect(text(first)).toContain("action-first");
    first.commit();
    const entries = [
      { type: "message", id: "u1", message: { role: "user", content: "Inspect the repository." } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Found target." }] } },
    ];
    const second = store.prepare({ ownerSessionId: "owner", branchIds: ["u1", "a1"], config, backend, dossier: dossier("second", entries) });
    expect(second).toMatchObject({ mode: "delta", reason: "validated-prefix" });
    expect(second.context?.messages).toHaveLength(3);
    expect(text(second)).toContain("action-second");
    expect(text(second)).not.toContain("action-first");
    expect(text(second)).toContain("Found target.");
    second.commit();
    expect(store.size).toBe(1);
  });

  it("resets for branch divergence, changed reviewer/policy, new host authorization, and pruned evidence", () => {
    const store = new ReviewerContinuity();
    const input = { ownerSessionId: "owner", branchIds: ["u1"], config, backend, dossier: dossier() };
    store.prepare(input).commit();
    const branch = store.prepare({ ...input, branchIds: ["sibling"] });
    expect(branch).toMatchObject({ mode: "reset", reason: "branch-mismatch" });
    expect(branch.context?.messages).toHaveLength(1);
    expect(store.prepare({ ...input, config: { ...config, policy: `${config.policy}\nNew restriction` } })).toMatchObject({ mode: "reset", reason: "identity-changed" });
    expect(store.prepare({ ...input, backend: { ...backend, id: "different" } })).toMatchObject({ mode: "reset", reason: "identity-changed" });
    const newUser = dossier("later", [
      { type: "message", id: "u1", message: { role: "user", content: "Inspect the repository." } },
      { type: "message", id: "u2", message: { role: "user", content: "Do not inspect the repository now." } },
    ]);
    expect(store.prepare({ ...input, branchIds: ["u1", "u2"], dossier: newUser })).toMatchObject({ mode: "reset", reason: "identity-changed" });
    // A same-branch result whose optional facts were evicted cannot use an old cursor.
    const prior = dossier("old", [{ type: "message", id: "u1", message: { role: "user", content: "Inspect the repository." } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "older fact" }] } }]);
    store.prepare({ ...input, branchIds: ["u1", "a1"], dossier: prior }).commit();
    expect(store.prepare({ ...input, branchIds: ["u1", "a1", "a2"], dossier: dossier("new") })).toMatchObject({ mode: "reset", reason: "evidence-mismatch" });
  });

  it("does not reuse missing cursors or persist evidence through reload; Jev gets the assembled snapshot", () => {
    const store = new ReviewerContinuity();
    const input = { config, backend, dossier: dossier() };
    const missing = store.prepare({ ...input, ownerSessionId: "owner" });
    missing.commit();
    expect(missing).toMatchObject({ mode: "full", reason: "missing-cursor" });
    expect(store.size).toBe(0);
    store.prepare({ ...input, ownerSessionId: "owner", branchIds: ["u1"] }).commit();
    const pendingAtShutdown = store.prepare({ ...input, ownerSessionId: "owner", branchIds: ["u1"] });
    store.clear();
    pendingAtShutdown.commit();
    expect(store.size).toBe(0);
    expect(store.prepare({ ...input, ownerSessionId: "owner", branchIds: ["u1"] }).mode).toBe("full");
    expect(new ReviewerContinuity().prepare({ ...input, ownerSessionId: "owner", branchIds: ["u1"] }).mode).toBe("full");
    expect(store.prepare({ ...input, backend: jevReviewer, ownerSessionId: "owner", branchIds: ["u1"] }).mode).toBe("snapshot");
  });

  it("bounds retained sessions and prevents late concurrent cursor commits from overwriting newer context", () => {
    const store = new ReviewerContinuity();
    const input = { config, backend, dossier: dossier() };
    const first = store.prepare({ ...input, ownerSessionId: "owner", branchIds: ["u1"] });
    const parallel = store.prepare({ ...input, ownerSessionId: "owner", branchIds: ["u1"] });
    parallel.commit();
    first.commit();
    expect(store.size).toBe(0); // stale commit invalidates cursor instead of replacing it
    for (let i = 0; i < 40; i++) store.prepare({ ...input, ownerSessionId: `owner-${i}`, branchIds: ["u1"] }).commit();
    expect(store.size).toBeLessThanOrEqual(16);
    expect(store.prepare({ ...input, ownerSessionId: "owner-0", branchIds: ["u1"] }).mode).toBe("full");
  });

  it("rebuilds full if a valid delta would exceed the chat model's request budget", () => {
    const store = new ReviewerContinuity();
    const input = { ownerSessionId: "owner", branchIds: ["u1"], config, backend, dossier: dossier() };
    store.prepare(input).commit();
    const required = estimateReviewerRequestTokens(config, backend, input.dossier);
    const constrained: ReviewerBackend = { kind: "chat", provider: "test", id: "reviewer", model: {
      ...backend.model, contextWindow: required + 4_096, maxTokens: 4_096,
    } as Model<any> };
    const next = store.prepare({ ...input, branchIds: ["u1", "a1"], backend: constrained });
    expect(next).toMatchObject({ mode: "reset", reason: "delta-budget" });
    expect(text(next)).toContain("action-first");
  });
  it("redacts structured credentials in the current delta action rather than copying raw facts", () => {
    const store = new ReviewerContinuity();
    store.prepare({ ownerSessionId: "owner", branchIds: ["u1"], backend, config, dossier: dossier() }).commit();
    const current = dossier("secret");
    const unsafe = { ...current, action: { ...current.action, action: { ...current.action.action, input: { token: "private-test-token" } } } };
    const next = store.prepare({ ownerSessionId: "owner", branchIds: ["u1"], backend, config, dossier: unsafe });
    expect(next.mode).toBe("delta");
    expect(text(next)).not.toContain("private-test-token");
    expect(text(next)).toContain("[REDACTED_SECRET]");
  });

});
