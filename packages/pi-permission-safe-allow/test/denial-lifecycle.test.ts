import { describe, expect, it } from "vitest";

import { DenialLifecycle } from "#safe/denial-lifecycle";
import { buildApprovalDossier } from "#safe/dossier";
import { makeDetails } from "#test/fixtures";

function dossier() {
  const value = buildApprovalDossier({ details: makeDetails(), evidence: [] });
  if (!value) throw new Error("fixture should produce a dossier");
  return value;
}

describe("DenialLifecycle", () => {
  it("trips after three consecutive denials and resets on a non-denial", () => {
    const lifecycle = new DenialLifecycle();
    expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "no", now: 1 }).circuitBreaker).toBeNull();
    expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "no", now: 2 }).circuitBreaker).toBeNull();
    lifecycle.recordNonDenial();
    expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "no", now: 3 }).circuitBreaker).toBeNull();
    expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "no", now: 4 }).circuitBreaker).toBeNull();
    expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "no", now: 5 }).circuitBreaker).toBe("consecutive");
  });

  it("consumes an exact override once and does not grant similar actions", () => {
    const lifecycle = new DenialLifecycle();
    const denial = lifecycle.recordDenial({ dossier: dossier(), rationale: "risk", now: 10 }).record;
    expect(lifecycle.authorizeOneRetry(denial.denialId)).toBe(true);
    lifecycle.resetTurn();
    expect(lifecycle.consumeOverride("similar-action")).toBeNull();
    expect(lifecycle.consumeOverride("action-1")).toMatchObject({
      priorDenialId: denial.denialId,
      oneShot: true,
    });
    expect(lifecycle.consumeOverride("action-1")).toBeNull();
  });

  it("retains at most ten recent denials", () => {
    const lifecycle = new DenialLifecycle();
    for (let i = 0; i < 12; i++) {
      lifecycle.recordDenial({ dossier: dossier(), rationale: "risk", now: i });
    }
    expect(lifecycle.recentDenials()).toHaveLength(10);
  });

  it("keeps batch refusals available without stopping independent calls", () => {
    const lifecycle = new DenialLifecycle();
    for (let i = 0; i < 12; i++) {
      const denied = lifecycle.recordDenial({
        dossier: dossier(), rationale: "Batch refusal", now: i,
        countTowardCircuitBreaker: false,
      });
      expect(denied.circuitBreaker).toBeNull();
    }
    expect(lifecycle.recentDenials()).toHaveLength(10);
    const denied = lifecycle.recentDenials()[0]!;
    expect(lifecycle.authorizeOneRetry(denied.denialId)).toBe(true);
    expect(lifecycle.consumeOverride(denied.exactActionId)).toMatchObject({ oneShot: true });
    expect(lifecycle.consumeOverride(denied.exactActionId)).toBeNull();
  });

  it("does not let batch refusals advance or reset the single-call breaker", () => {
    const lifecycle = new DenialLifecycle();
    for (let i = 0; i < 2; i++) {
      expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "Single refusal" }).circuitBreaker).toBeNull();
    }
    for (let i = 0; i < 12; i++) {
      expect(lifecycle.recordDenial({
        dossier: dossier(), rationale: "Batch refusal", countTowardCircuitBreaker: false,
      }).circuitBreaker).toBeNull();
    }
    expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "Single refusal" }).circuitBreaker).toBe("consecutive");
  });

  it("does not let batch refusals fill the rolling single-call window", () => {
    const lifecycle = new DenialLifecycle();
    for (let i = 0; i < 9; i++) {
      expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "Single refusal" }).circuitBreaker).toBeNull();
      lifecycle.recordNonDenial();
    }
    for (let i = 0; i < 12; i++) {
      expect(lifecycle.recordDenial({
        dossier: dossier(), rationale: "Batch refusal", countTowardCircuitBreaker: false,
      }).circuitBreaker).toBeNull();
    }
    expect(lifecycle.recordDenial({ dossier: dossier(), rationale: "Single refusal" }).circuitBreaker).toBe("rolling");
  });
});
