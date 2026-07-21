import { describe, expect, it } from "vitest";

import {
  enforceGuardianThresholds,
  parseReviewerDecision,
  type ReviewerDecision,
} from "#safe/review-contract";

const base: ReviewerDecision = {
  riskLevel: "low",
  userAuthorization: "low",
  verdict: "allow",
  rationale: "Routine repository inspection.",
  scope: "narrow",
  absoluteDeny: false,
};

describe("Guardian-aligned review contract", () => {
  it.each(["low", "medium"] as const)("permits a reviewer allow at %s risk", (riskLevel) => {
    expect(enforceGuardianThresholds({ ...base, riskLevel }).verdict).toBe("allow");
  });

  it("uses allow as the default low/medium threshold absent an absolute deny", () => {
    expect(
      enforceGuardianThresholds({
        ...base,
        riskLevel: "medium",
        verdict: "deny",
        rationale: "Conservative reviewer preference.",
      }).verdict,
    ).toBe("allow");
  });

  it("denies critical risk regardless of reviewer allow", () => {
    expect(enforceGuardianThresholds({ ...base, riskLevel: "critical" }).verdict).toBe("deny");
  });

  it("requires high-risk actions to be narrow and at least medium-authorized", () => {
    expect(
      enforceGuardianThresholds({
        ...base,
        riskLevel: "high",
        userAuthorization: "low",
      }).verdict,
    ).toBe("deny");
    expect(
      enforceGuardianThresholds({
        ...base,
        riskLevel: "high",
        userAuthorization: "medium",
      }).verdict,
    ).toBe("allow");
  });

  it("rejects malformed or defer-shaped output", () => {
    expect(parseReviewerDecision('{"verdict":"defer"}')).toBeNull();
    expect(parseReviewerDecision("not json")).toBeNull();
  });
});
