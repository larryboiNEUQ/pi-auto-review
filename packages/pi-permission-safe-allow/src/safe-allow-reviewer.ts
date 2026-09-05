import { createHash } from "node:crypto";

import type { Authorizer } from "@gotgenes/pi-permission-system";

import { GUARDIAN_POLICY_VERSION, type SafeAllowConfig } from "./config-schema";
import { buildApprovalDossier } from "./dossier";
import type { DenialLifecycle } from "./denial-lifecycle";
import { logSafeAllow } from "./log";
import { scanLiteralShellChain } from "./literal-shell-scanner";
import {
  type CompleteFn,
  type ModelRegistryLike,
  reviewDossier,
} from "./model-review";
import { resolveReviewerBackend } from "./reviewer-backend";
import { resolveJevTransport, type EvaluateJevFn } from "./jev-evaluation";
import { runReadOnlyProbes } from "./read-only-probes";

const NON_CIRCUMVENTION =
  "Do not pursue the same outcome through a workaround, indirect execution, or policy circumvention. Choose a materially safer alternative or stop and ask the user.";

export interface SafeAllowReviewerDeps {
  getConfig: () => SafeAllowConfig | undefined;
  getRegistry: () => ModelRegistryLike | undefined;
  getEvidence: () => readonly unknown[];
  getSignal: () => AbortSignal | undefined;
  lifecycle: DenialLifecycle;
  complete: CompleteFn;
  evaluate?: EvaluateJevFn;
  audit?: typeof logSafeAllow;
  onCircuitBreaker?: (kind: "consecutive" | "rolling") => void;
}

function failureReason(code: string, message: string): string {
  const label = code === "timeout" ? "Delegated review timed out" : `Delegated review failed (${code})`;
  return `${label}; the action was not executed. ${message}`;
}

const SHELL_WRAPPER_HEAD_PATTERN =
  String.raw`(?:\/?[^\s/]+\/)*(?:bash|sh|dash|zsh|ksh)\s+-[A-Za-z]*c[A-Za-z]*`;
const LITERAL_WRAPPER_PATTERN = new RegExp(
  `^(?:${SHELL_WRAPPER_HEAD_PATTERN}|eval)\\s+(["'])([\\s\\S]*)\\1$`,
);
const WRAPPER_PREFIX_PATTERN = new RegExp(
  `^(?:${SHELL_WRAPPER_HEAD_PATTERN}\\b|eval\\b)`,
);


function decomposeLiteralShellCommand(command: string): string[] | undefined {
  if (/[`$]/.test(command)) return undefined;

  const trimmedCommand = command.trim();
  const wrapper = LITERAL_WRAPPER_PATTERN.exec(trimmedCommand);
  if (wrapper) {
    const delimiter = wrapper[1];
    const payload = wrapper[2];
    return payload && delimiter && !payload.includes(delimiter)
      ? decomposeLiteralShellCommand(payload)
      : undefined;
  }
  if (WRAPPER_PREFIX_PATTERN.test(trimmedCommand)) return undefined;

  const scanned = scanLiteralShellChain(command);
  if (!scanned.certain) return undefined;
  const leaves = scanned.leaves;
  if (leaves.length === 1) return [leaves[0]!.trim()];

  const decomposed = leaves.flatMap((leaf) => {
    const nested = decomposeLiteralShellCommand(leaf.trim());
    return nested ?? [];
  });
  return decomposed.length === leaves.length ? decomposed : undefined;
}

export function createSafeAllowReviewer(
  deps: SafeAllowReviewerDeps,
): Authorizer["authorize"] {
  const audit = deps.audit ?? logSafeAllow;
  return async (details, query) => {
    const config = deps.getConfig();
    if (!config || config.disabled) {
      audit("authorize.defer", {
        reason: config?.disabled ? "disabled" : "no_config",
      });
      return { kind: "defer" };
    }
    const auditContext = {
      policyVersion: GUARDIAN_POLICY_VERSION,
      policyHash: createHash("sha256").update(config.policy, "utf8").digest("hex"),
      probeUsed: false,
    };

    const facts = details.delegatedApproval;
    let completedFacts = facts;
    let probeEvidence;
    if (!facts?.complete && config.readOnlyProbes) {
      const probe = await runReadOnlyProbes({
        details,
        query,
        maxHops: config.probeMaxHops,
        timeoutMs: config.probeTimeoutMs,
        signal: deps.getSignal(),
      });
      if (probe.kind === "completed") {
        if (!audit("probe.completed", {
          requestId: details.requestId,
          actionId: probe.facts.exactActionId,
          hops: probe.hops,
          durationMs: probe.durationMs,
          evidence: probe.evidence,
        })) {
          return {
            kind: "deny",
            reason: failureReason(
              "audit",
              "The read-only probe evidence could not be recorded.",
            ),
          };
        }
        completedFacts = probe.facts;
        probeEvidence = probe.evidence;
      } else {
        audit("review.failure", {
          requestId: details.requestId,
          code: `probe_${probe.code}`,
          missing: facts?.missing ?? ["delegatedApproval"],
          hops: probe.hops,
          durationMs: probe.durationMs,
        });
        return {
          kind: "deny",
          reason: failureReason(
            `probe_${probe.code}`,
            probe.message,
          ),
        };
      }
    }
    if (!completedFacts?.complete) {
      audit("review.failure", {
        requestId: details.requestId,
        code: "missing_dossier",
        missing: completedFacts?.missing ?? ["delegatedApproval"],
      });
      return {
        kind: "deny",
        reason: failureReason(
          "missing_evidence",
          "The exact action dossier is incomplete.",
        ),
      };
    }

    if (
      completedFacts.surface === "bash" &&
      completedFacts.policy?.state === "ask" &&
      completedFacts.policy?.matchedPattern === "<opaque-bash-wrapper>" &&
      typeof completedFacts.action.command === "string"
    ) {
      const innerCommands = decomposeLiteralShellCommand(completedFacts.action.command);
      if (innerCommands) {
        let everyLeafAllowed = true;
        for (const innerCommand of innerCommands) {
          const result = query.checkPermission(
            "bash",
            innerCommand,
            details.agentName ?? undefined,
          );
          if (result.state === "deny") {
            audit("review.decision", {
              requestId: details.requestId,
              actionId: completedFacts.exactActionId,
              attempts: 0,
              riskLevel: null,
              userAuthorization: null,
              verdict: "deny",
              rationale: result.reason ?? "A decomposed command is deterministically denied.",
              ...auditContext,
            });
            return {
              kind: "deny",
              reason:
                result.reason ??
                "A decomposed command is denied by recorded permission policy.",
            };
          }
          if (result.state !== "allow") everyLeafAllowed = false;
        }
        if (everyLeafAllowed) {
          const audited = audit("review.decision", {
            requestId: details.requestId,
            actionId: completedFacts.exactActionId,
            attempts: 0,
            riskLevel: null,
            userAuthorization: null,
            verdict: "allow",
            rationale: "Every faithfully decomposed leaf is deterministically allowed.",
            ...auditContext,
          });
          return audited
            ? { kind: "allow" }
            : {
                kind: "deny",
                reason: failureReason(
                  "audit",
                  "The deterministic allow decision could not be recorded.",
                ),
              };
        }
      }
    }

    const override = deps.lifecycle.consumeOverride(completedFacts.exactActionId);
    const dossier = buildApprovalDossier({
      details,
      evidence: deps.getEvidence(),
      evidencePolicy: { includeToolResults: config.includeToolResults },
      override,
      completedAction: completedFacts,
      probeEvidence,
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
    auditContext.probeUsed = Boolean(probeEvidence);

    if (
      !audit("review.routed", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        surface: dossier.action.surface,
        actionKind: dossier.action.action.kind,
        override: Boolean(override),
        evidence: dossier.evidence,
        ...auditContext,
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
      model = registry && resolveReviewerBackend(registry, config.provider, config.model);
    } catch (error) {
      audit("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "model_resolution",
        ...auditContext,
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
      audit("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "model_resolution",
        ...auditContext,
      });
      return {
        kind: "deny",
        reason: failureReason("model_resolution", "The configured reviewer model is unavailable."),
      };
    }

    Object.assign(auditContext, { provider: model.provider, model: model.id, backend: model.kind,
      ...(model.kind === "evaluation"
        ? {
            questionContractVersion: model.contractVersion,
            jevTransport: resolveJevTransport().transport,
          }
        : {}) });

    let outcome;
    try {
      outcome = await reviewDossier({
        dossier,
        config,
        backend: model,
        evaluate: deps.evaluate,
        registry,
        complete: deps.complete,
        signal: deps.getSignal(),
      });
    } catch (error) {
      audit("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "review_session",
        ...auditContext,
      });
      return {
        kind: "deny",
        reason: failureReason(
          "review_session",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    if (outcome.kind === "failure") {
      audit("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: outcome.code,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
        ...auditContext,
      });
      return { kind: "deny", reason: failureReason(outcome.code, outcome.message) };
    }

    const { decision } = outcome;
    const auditDecision = (extra: Record<string, unknown> = {}): boolean =>
      audit("review.decision", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        riskLevel: decision.riskLevel,
        userAuthorization: decision.userAuthorization,
        verdict: decision.verdict,
        scope: decision.scope,
        absoluteDeny: decision.absoluteDeny,
        rationale: decision.rationale,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
        override: Boolean(override),
        ...extra,
        ...auditContext,
      });
    if (decision.verdict === "allow") {
      deps.lifecycle.recordNonDenial();
      const audited = auditDecision();
      if (!audited) {
        return {
          kind: "deny",
          reason: failureReason(
            "audit",
            "The final allow decision could not be recorded.",
          ),
        };
      }
      return { kind: "allow" };
    }

    const escalatesToTerminal =
      decision.riskLevel !== "critical" && !decision.absoluteDeny;
    if (escalatesToTerminal) {
      const audited = auditDecision({
        escalated: true,
        escalation: "terminal_authority",
      });
      if (!audited) {
        return {
          kind: "deny",
          reason: failureReason(
            "audit",
            "The reviewer denial escalation could not be recorded.",
          ),
        };
      }
      // Advance the breaker window and clear consecutive hard-deny streak
      // without recording a /approve denial (ordinary escalations stay out of
      // recentDenials). Mirrors the allow path's recordNonDenial().
      deps.lifecycle.recordNonDenial();
      return { kind: "defer" };
    }

    const denial = deps.lifecycle.recordDenial({
      dossier,
      rationale: decision.rationale,
      riskLevel: decision.riskLevel,
    });
    auditDecision({
      denialId: denial.record.denialId,
      escalated: false,
      circuitBreaker: denial.circuitBreaker,
    });
    if (denial.circuitBreaker) deps.onCircuitBreaker?.(denial.circuitBreaker);
    return {
      kind: "deny",
      reason: `${decision.rationale} ${NON_CIRCUMVENTION}`,
    };
  };
}
