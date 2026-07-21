import type { ApprovalDossier } from "./dossier";
import type { RiskLevel } from "./review-contract";

export interface DenialRecord {
  denialId: string;
  requestId: string;
  exactActionId: string;
  summary: string;
  rationale: string;
  riskLevel: RiskLevel | "unknown";
  timestamp: number;
}

export interface DenialStateResult {
  record: DenialRecord;
  circuitBreaker: "consecutive" | "rolling" | null;
}

export class DenialLifecycle {
  private outcomes: boolean[] = [];
  private consecutiveDenials = 0;
  private denials: DenialRecord[] = [];
  private overrides = new Map<string, string>();

  resetTurn(): void {
    this.outcomes = [];
    this.consecutiveDenials = 0;
  }

  resetSession(): void {
    this.resetTurn();
    this.denials = [];
    this.overrides.clear();
  }

  recordNonDenial(): void {
    this.outcomes.push(false);
    this.outcomes = this.outcomes.slice(-50);
    this.consecutiveDenials = 0;
  }

  recordDenial(inputs: {
    dossier: ApprovalDossier;
    rationale: string;
    riskLevel?: RiskLevel;
    now?: number;
  }): DenialStateResult {
    const now = inputs.now ?? Date.now();
    const record: DenialRecord = {
      denialId: `${inputs.dossier.request.id}:${now}`,
      requestId: inputs.dossier.request.id,
      exactActionId: inputs.dossier.action.exactActionId,
      summary: `${inputs.dossier.action.action.kind} ${inputs.dossier.action.value}`,
      rationale: inputs.rationale,
      riskLevel: inputs.riskLevel ?? "unknown",
      timestamp: now,
    };
    this.denials = [...this.denials, record].slice(-10);
    this.outcomes.push(true);
    this.outcomes = this.outcomes.slice(-50);
    this.consecutiveDenials++;
    const rollingDenials = this.outcomes.filter(Boolean).length;
    return {
      record,
      circuitBreaker:
        this.consecutiveDenials >= 3
          ? "consecutive"
          : rollingDenials >= 10
            ? "rolling"
            : null,
    };
  }

  recentDenials(): readonly DenialRecord[] {
    return [...this.denials].reverse();
  }

  authorizeOneRetry(denialId: string): boolean {
    const denial = this.denials.find((entry) => entry.denialId === denialId);
    if (!denial) return false;
    this.overrides.set(denial.exactActionId, denial.denialId);
    return true;
  }

  consumeOverride(exactActionId: string): ApprovalDossier["override"] {
    const priorDenialId = this.overrides.get(exactActionId);
    if (!priorDenialId) return null;
    this.overrides.delete(exactActionId);
    return {
      exactActionId,
      priorDenialId,
      explicitlyAuthorizedByUser: true,
      oneShot: true,
    };
  }
}
