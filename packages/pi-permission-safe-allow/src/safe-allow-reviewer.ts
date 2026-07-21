import type { Authorizer } from "@gotgenes/pi-permission-system";

import type { SafeAllowConfig } from "./config-schema";
import { buildApprovalDossier } from "./dossier";
import type { DenialLifecycle } from "./denial-lifecycle";
import { logSafeAllow } from "./log";
import {
  type CompleteFn,
  type ModelRegistryLike,
  reviewDossier,
} from "./model-review";

const NON_CIRCUMVENTION =
  "Do not pursue the same outcome through a workaround, indirect execution, or policy circumvention. Choose a materially safer alternative or stop and ask the user.";

export interface SafeAllowReviewerDeps {
  getConfig: () => SafeAllowConfig | undefined;
  getRegistry: () => ModelRegistryLike | undefined;
  getEvidence: () => readonly unknown[];
  getSignal: () => AbortSignal | undefined;
  lifecycle: DenialLifecycle;
  complete: CompleteFn;
  onCircuitBreaker?: (kind: "consecutive" | "rolling") => void;
}

function failureReason(code: string, message: string): string {
  const label = code === "timeout" ? "Delegated review timed out" : `Delegated review failed (${code})`;
  return `${label}; the action was not executed. ${message}`;
}

export function createSafeAllowReviewer(
  deps: SafeAllowReviewerDeps,
): Authorizer["authorize"] {
  return async (details) => {
    const config = deps.getConfig();
    if (!config || config.disabled) {
      logSafeAllow("authorize.defer", {
        reason: config?.disabled ? "disabled" : "no_config",
      });
      return { kind: "defer" };
    }

    const facts = details.delegatedApproval;
    if (!facts?.complete) {
      logSafeAllow("review.failure", {
        requestId: details.requestId,
        code: "missing_dossier",
        missing: facts?.missing ?? ["delegatedApproval"],
      });
      return {
        kind: "deny",
        reason: failureReason(
          "missing_evidence",
          "The exact action dossier is incomplete.",
        ),
      };
    }

    const override = deps.lifecycle.consumeOverride(facts.exactActionId);
    const dossier = buildApprovalDossier({
      details,
      evidence: deps.getEvidence(),
      override,
    });
    if (!dossier) {
      return {
        kind: "deny",
        reason: failureReason(
          "missing_evidence",
          "The action is not an eligible, exact ask dossier.",
        ),
      };
    }

    if (dossier.action.action.kind === "skill") {
      deps.lifecycle.recordNonDenial();
      logSafeAllow("review.trusted_skill_allowed", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        skill: details.skillName ?? dossier.action.value,
      });
      return { kind: "allow" };
    }

    if (
      !logSafeAllow("review.routed", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        surface: dossier.action.surface,
        actionKind: dossier.action.action.kind,
        override: Boolean(override),
      })
    ) {
      return {
        kind: "deny",
        reason: failureReason("audit", "The audit event could not be written."),
      };
    }

    const registry = deps.getRegistry();
    let model;
    try {
      model = registry?.find(config.provider, config.model);
    } catch (error) {
      logSafeAllow("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "model_resolution",
      });
      return {
        kind: "deny",
        reason: failureReason(
          "model_resolution",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    if (!model || !registry) {
      logSafeAllow("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "model_resolution",
      });
      return {
        kind: "deny",
        reason: failureReason("model_resolution", "The configured reviewer model is unavailable."),
      };
    }

    let outcome;
    try {
      outcome = await reviewDossier({
        dossier,
        config,
        model,
        registry,
        complete: deps.complete,
        signal: deps.getSignal(),
      });
    } catch (error) {
      return {
        kind: "deny",
        reason: failureReason(
          "review_session",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    if (outcome.kind === "failure") {
      logSafeAllow("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: outcome.code,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
      });
      return { kind: "deny", reason: failureReason(outcome.code, outcome.message) };
    }

    const { decision } = outcome;
    if (decision.verdict === "allow") {
      deps.lifecycle.recordNonDenial();
      logSafeAllow("review.decision", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        riskLevel: decision.riskLevel,
        userAuthorization: decision.userAuthorization,
        verdict: "allow",
        rationale: decision.rationale,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
        override: Boolean(override),
      });
      return { kind: "allow" };
    }

    const denial = deps.lifecycle.recordDenial({
      dossier,
      rationale: decision.rationale,
      riskLevel: decision.riskLevel,
    });
    logSafeAllow("review.decision", {
      requestId: dossier.request.id,
      denialId: denial.record.denialId,
      actionId: dossier.action.exactActionId,
      riskLevel: decision.riskLevel,
      userAuthorization: decision.userAuthorization,
      verdict: "deny",
      rationale: decision.rationale,
      attempts: outcome.attempts,
      durationMs: outcome.durationMs,
      override: Boolean(override),
      circuitBreaker: denial.circuitBreaker,
    });
    if (denial.circuitBreaker) deps.onCircuitBreaker?.(denial.circuitBreaker);
    return {
      kind: "deny",
      reason: `${decision.rationale} ${NON_CIRCUMVENTION}`,
    };
  };
}
