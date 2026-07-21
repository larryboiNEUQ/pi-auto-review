export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const AUTHORIZATION_LEVELS = ["unknown", "low", "medium", "high"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type AuthorizationLevel = (typeof AUTHORIZATION_LEVELS)[number];

export interface ReviewerDecision {
  riskLevel: RiskLevel;
  userAuthorization: AuthorizationLevel;
  verdict: "allow" | "deny";
  rationale: string;
  scope: "narrow" | "broad";
  absoluteDeny: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReviewerDecision(text: string): ReviewerDecision | null {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (!RISK_LEVELS.includes(parsed.riskLevel as RiskLevel)) return null;
  if (!AUTHORIZATION_LEVELS.includes(parsed.userAuthorization as AuthorizationLevel)) return null;
  if (parsed.verdict !== "allow" && parsed.verdict !== "deny") return null;
  if (typeof parsed.rationale !== "string" || !parsed.rationale.trim()) return null;
  if (parsed.scope !== "narrow" && parsed.scope !== "broad") return null;
  if (typeof parsed.absoluteDeny !== "boolean") return null;
  return {
    riskLevel: parsed.riskLevel as RiskLevel,
    userAuthorization: parsed.userAuthorization as AuthorizationLevel,
    verdict: parsed.verdict,
    rationale: parsed.rationale.trim(),
    scope: parsed.scope,
    absoluteDeny: parsed.absoluteDeny,
  };
}

export function enforceGuardianThresholds(decision: ReviewerDecision): ReviewerDecision {
  if (decision.absoluteDeny || decision.riskLevel === "critical") {
    return { ...decision, verdict: "deny" };
  }
  if (
    decision.riskLevel === "high" &&
    (decision.scope !== "narrow" ||
      !["medium", "high"].includes(decision.userAuthorization))
  ) {
    return {
      ...decision,
      verdict: "deny",
      rationale:
        `${decision.rationale} High-risk actions require medium-or-higher explicit authorization and narrow scope.`,
    };
  }
  if (decision.riskLevel === "low" || decision.riskLevel === "medium") {
    return { ...decision, verdict: "allow" };
  }
  return decision;
}
