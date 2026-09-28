import { createHash } from "node:crypto";

import type { Authorizer } from "#src/authority/authorizer";
import type { ReviewerFailureCode } from "#src/permission-events";

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

function boundedFailureCode(code: string): ReviewerFailureCode {
  if (
    code === "auth" ||
    code === "cancelled" ||
    code === "model" ||
    code === "parse" ||
    code === "timeout" ||
    code === "transport"
  ) {
    return code;
  }
  if (code === "audit") return "audit";
  if (code.startsWith("probe_")) return "probe";
  if (code === "missing_evidence" || code === "missing_dossier") {
    return "evidence";
  }
  return "model";
}

function unavailable(code: string) {
  const boundedCode = boundedFailureCode(code);
  const label =
    boundedCode === "timeout" ? "timed out" : `failed (${boundedCode})`;
  const timeoutContext =
    boundedCode === "timeout"
      ? " Timeout is not evidence that the action is unsafe."
      : "";
  return {
    kind: "unavailable" as const,
    source: "reviewer_failure" as const,
    code: boundedCode,
    reason: `Automated review ${label}; the action was not executed.${timeoutContext} Retry the request after the reviewer service is available.`,
  };
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
            ...unavailable("audit"),
          };
        }
        completedFacts = probe.facts;
        probeEvidence = probe.evidence;
      } else {
        audit("review.failure", {
          requestId: details.requestId,
          code: "probe",
          missing: facts?.missing ?? ["delegatedApproval"],
          hops: probe.hops,
          durationMs: probe.durationMs,
        });
        return unavailable(`probe_${probe.code}`);
      }
    }
    if (!completedFacts?.complete) {
      audit("review.failure", {
        requestId: details.requestId,
        code: "evidence",
        missing: completedFacts?.missing ?? ["delegatedApproval"],
      });
      return unavailable("missing_evidence");
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
              source: "policy",
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
                ...unavailable("audit"),
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
      const audited = audit("review.failure", {
        requestId: details.requestId,
        code: "evidence",
        ...auditContext,
      });
      return unavailable(audited ? "missing_evidence" : "audit");
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
      return unavailable("audit");
    }

    const registry = deps.getRegistry();
    let model;
    try {
      model = registry && resolveReviewerBackend(registry, config.provider, config.model);
    } catch {
      audit("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "model",
        ...auditContext,
      });
      return unavailable("model");
    }
    if (!model || !registry) {
      audit("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "model",
        ...auditContext,
      });
      return unavailable("model");
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
    } catch {
      audit("review.failure", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        code: "model",
        ...auditContext,
      });
      return unavailable("model");
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
      return unavailable(outcome.code);
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
        return unavailable("audit");
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
        return unavailable("audit");
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
    const audited = auditDecision({
      denialId: denial.record.denialId,
      escalated: false,
      circuitBreaker: denial.circuitBreaker,
    });
    if (!audited) return unavailable("audit");
    if (denial.circuitBreaker) deps.onCircuitBreaker?.(denial.circuitBreaker);
    return {
      kind: "deny",
      source: "reviewer",
      reason: `${decision.rationale} ${NON_CIRCUMVENTION}`,
    };
  };
}
