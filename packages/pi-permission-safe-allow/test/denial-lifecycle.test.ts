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
});
