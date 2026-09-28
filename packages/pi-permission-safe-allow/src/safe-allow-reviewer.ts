import { createHash } from "node:crypto";

import type { Authorizer } from "#src/authority/authorizer";
import { type ToolBatchProvenance, toolBatchProvenance } from "#src/authority/tool-batch-provenance";
import type { ReviewerFailureCode } from "#src/permission-events";

import { GUARDIAN_POLICY_VERSION, type SafeAllowConfig } from "./config-schema";
import { buildApprovalDossier, type ApprovalDossier, type ProbeEvidence } from "./dossier";
import type { DenialLifecycle } from "./denial-lifecycle";
import { logSafeAllow } from "./log";
import { scanLiteralShellChain } from "./literal-shell-scanner";
import {
  type CompleteFn,
  type ModelRegistryLike,
  reviewDossier,
  type ReviewOutcome,
} from "./model-review";
import { admitReviewerRequest, resolveReviewerBackend } from "./reviewer-backend";
import { ReviewerContinuity } from "./review-continuity";
import { resolveJevTransport, type EvaluateJevFn } from "./jev-evaluation";
import { runReadOnlyProbes } from "./read-only-probes";
import { requestFact } from "./investigation-broker";

const NON_CIRCUMVENTION =
  "Do not pursue the same outcome through a workaround, indirect execution, or policy circumvention. Choose a materially safer alternative or stop and ask the user.";

export interface SafeAllowReviewerDeps {
  getConfig: () => SafeAllowConfig | undefined;
  getRegistry: () => ModelRegistryLike | undefined;
  getEvidence: () => readonly unknown[];
  /** Host-owned session identity, never inferred from tool output or entry metadata. */
  getOwnerSessionId?: () => string | undefined;
  /** Ordered entry IDs from the host's active branch; missing IDs disable reuse. */
  getBranchIds?: () => readonly string[] | undefined;
  /** Public Pi pending-input indicator catches queued steering before session persistence. */
  hasPendingMessages?: () => boolean;
  /** Trusted host adapter; absence defaults to active-branch proof or fail-closed. */
  getBatchProvenance?: (toolCallId: string) => ToolBatchProvenance;
  continuity?: ReviewerContinuity;
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
  if (code.startsWith("probe_") || code.startsWith("investigation_")) return "probe";
  if (
    code === "evidence" ||
    code === "missing_evidence" ||
    code === "missing_dossier" ||
    code === "authorization_changed" ||
    code === "batch_release_unfenced"
  ) {
    return "evidence";
  }
  return "model";
}

/** `guidance` replaces the generic retry advice when the cause is not service availability. */
function unavailable(code: string, guidance?: string) {
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
    reason: `Automated review ${label}; the action was not executed.${timeoutContext} ${guidance ?? "Retry the request after the reviewer service is available."}`,
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
  const continuity = deps.continuity ?? new ReviewerContinuity();
  return async (details, query) => {
    const config = deps.getConfig();
    if (!config || config.disabled) {
      audit("authorize.defer", {
        reason: config?.disabled ? "disabled" : "no_config",
      });
      return { kind: "defer" };
    }
    const askStarted = Date.now();
    const deadline = askStarted + config.timeoutMs;
    const auditContext = {
      policyVersion: GUARDIAN_POLICY_VERSION,
      policyHash: createHash("sha256").update(config.policy, "utf8").digest("hex"),
      probeUsed: false,
    };
    if (deps.hasPendingMessages?.()) {
      audit("review.failure", { requestId: details.requestId, code: "authorization_changed", reason: "pending_user_input", ...auditContext });
      return unavailable("authorization_changed", "Pending user input must be resolved before this action is reviewed.");
    }
    // A forwarded ask's batch lives in the child's transcript, not this
    // session's history, so only the child-attested provenance can prove it.
    const batchProvenance: ToolBatchProvenance = details.forwarding
      ? details.forwardedBatchProvenance ?? "unknown"
      : !details.toolCallId
        ? "unknown"
        : deps.getBatchProvenance?.(details.toolCallId) ?? toolBatchProvenance(deps.getEvidence(), details.toolCallId);
    if (batchProvenance !== "single") {
      audit("review.failure", { requestId: details.requestId, actionId: details.delegatedApproval?.exactActionId,
        code: "batch_release_unfenced", provenance: batchProvenance, forwarded: Boolean(details.forwarding), ...auditContext });
      return unavailable("batch_release_unfenced", "This Pi runtime cannot prove that the delegated ask is a single tool call at the executor seam; retry it alone in the originating session.");
    }

    const facts = details.delegatedApproval;
    let completedFacts = facts;
    let probeEvidence: ProbeEvidence[] | undefined;
    if (!facts?.complete && config.readOnlyProbes) {
      if (Date.now() >= deadline || deps.getSignal()?.aborted) return unavailable("timeout");
      const probe = await runReadOnlyProbes({
        details,
        query,
        maxHops: config.probeMaxHops,
        timeoutMs: Math.min(config.probeTimeoutMs, Math.max(0, deadline - Date.now())),
        signal: deps.getSignal(),
      });
      if (probe.kind === "completed") {
        if (Date.now() >= deadline || deps.getSignal()?.aborted) return unavailable("timeout");
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
    const ownerSessionId = deps.getOwnerSessionId?.();
    const branchIds = deps.getBranchIds?.();
    const evidence = deps.getEvidence();
    const dossier = buildApprovalDossier({
      details,
      evidence,
      evidencePolicy: { includeToolResults: config.includeToolResults, ownerSessionId },
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
        evidenceContractVersion: dossier.evidenceContractVersion,
        evidenceDiagnostics: dossier.evidenceDiagnostics,
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

    const admission = admitReviewerRequest(config, model, dossier);
    if (!audit("review.admission", {
      requestId: dossier.request.id,
      actionId: dossier.action.exactActionId,
      admitted: admission.ok,
      evidenceContractVersion: dossier.evidenceContractVersion,
      evidenceDiagnostics: admission.ok ? admission.dossier.evidenceDiagnostics : dossier.evidenceDiagnostics,
      ...auditContext,
    })) {
      return unavailable("audit");
    }
    if (!admission.ok) {
      audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId, code: "evidence", ...auditContext });
      return unavailable("evidence", admission.reason);
    }
    const prepared = continuity.prepare({ ownerSessionId, branchIds, backend: model, config, dossier: admission.dossier });
    if (!audit("review.continuity", {
      requestId: dossier.request.id, actionId: dossier.action.exactActionId,
      mode: prepared.mode, reason: prepared.reason, ...auditContext,
    })) return unavailable("audit");
    const stamp = (owner: string | undefined, branch: readonly string[] | undefined, effective: SafeAllowConfig, current: ApprovalDossier): string =>
      createHash("sha256").update(JSON.stringify({
        ownerSessionId: owner, branchIds: branch, config: effective,
        evidence: current.evidence, diagnostics: current.evidenceDiagnostics,
        probeEvidence: current.probeEvidence,
      })).digest("hex");
    let activeDossier = admission.dossier;
    let reviewedVersion = stamp(ownerSessionId, branchIds, config, activeDossier);
    const factsPermitted = (observations: readonly ProbeEvidence[] | undefined): boolean => {
      // Recheck captured paths independently of dossier-version bookkeeping:
      // a policy revocation must stop the fact before audit or further inference.
      for (const fact of observations ?? []) {
        if (fact.category !== "investigation") continue;
        try {
          if (query.checkPermission("read", fact.requestedPath, details.agentName ?? undefined).state !== "allow") return false;
          const pathRule = query.checkPermission("path", fact.requestedPath, details.agentName ?? undefined);
          if (pathRule.matchedPattern !== undefined && pathRule.state !== "allow") return false;
        } catch { return false; }
      }
      return true;
    };
    const stillCurrent = (): boolean => {
      if (deps.hasPendingMessages?.()) return false;
      const effective = deps.getConfig();
      if (!effective || effective.disabled || !factsPermitted(probeEvidence)) return false;
      const owner = deps.getOwnerSessionId?.();
      const branch = deps.getBranchIds?.();
      const fresh = buildApprovalDossier({
        details, evidence: deps.getEvidence(),
        evidencePolicy: { includeToolResults: effective.includeToolResults, ownerSessionId: owner },
        override, completedAction: completedFacts, probeEvidence,
      });
      const admitted = fresh && admitReviewerRequest(effective, model, fresh);
      return !!admitted?.ok && stamp(owner, branch, effective, admitted.dossier) === reviewedVersion;
    };
    const changed = () => {
      audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId,
        code: "authorization_changed", ...auditContext });
      return unavailable("authorization_changed", "Pending user input, session, branch, effective policy, or admitted evidence changed during review; retry under current authority.");
    };
    let outcome: ReviewOutcome | undefined;
    let totalAttempts = 0;
    const interactive = config.readOnlyProbes && config.investigationEnabled && model.kind === "chat";
    for (let round = 0; round < (interactive ? 3 : 1); round++) {
      if (Date.now() >= deadline || deps.getSignal()?.aborted) {
        audit("review.failure", { requestId: dossier.request.id, code: "timeout_or_cancelled", ...auditContext });
        return unavailable("timeout");
      }
      try {
        outcome = await reviewDossier({
          dossier: activeDossier, config, backend: model, evaluate: deps.evaluate,
          registry, complete: deps.complete, signal: deps.getSignal(),
          prepared: round === 0 ? prepared : undefined, deadlineMs: deadline,
          isCurrent: stillCurrent,
          ...(interactive ? { attempts: 1 } : {}),
        });
      } catch {
        audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId,
          code: "model", ...auditContext });
        return unavailable("model");
      }
      totalAttempts += outcome.attempts;
      if (outcome.kind === "failure") {
        audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId,
          code: outcome.code, attempts: totalAttempts, durationMs: Date.now() - askStarted, ...auditContext });
        return unavailable(outcome.code);
      }
      if (!stillCurrent()) return changed();
      if (outcome.kind === "reviewed") break;
      if (!interactive || round >= 2) {
        audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId,
          code: "investigation_budget", attempts: totalAttempts, ...auditContext });
        return unavailable("investigation_budget", "No further fact requests are permitted for this ask.");
      }
      const fact = await requestFact({
        request: outcome.request, facts: completedFacts, query, agentName: details.agentName ?? undefined,
        deadline, timeoutMs: config.probeTimeoutMs, signal: deps.getSignal(),
      });
      if (fact.kind === "failure") {
        audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId,
          code: `investigation_${fact.code}`, attempts: totalAttempts, ...auditContext });
        return unavailable(`investigation_${fact.code}`, "The requested fact could not be safely established.");
      }
      if (!stillCurrent() || !factsPermitted([...(probeEvidence ?? []), fact.evidence]) || Date.now() >= deadline || deps.getSignal()?.aborted) return changed();
      auditContext.probeUsed = true;
      if (!audit("probe.completed", { requestId: details.requestId, actionId: completedFacts.exactActionId,
        hops: round + 1, evidence: [fact.evidence], ...auditContext })) {
        return unavailable("audit");
      }
      probeEvidence = [...(probeEvidence ?? []), fact.evidence];
      const next = buildApprovalDossier({
        details, evidence: deps.getEvidence(),
        evidencePolicy: { includeToolResults: config.includeToolResults, ownerSessionId },
        override, completedAction: completedFacts, probeEvidence,
      });
      const nextAdmission = next && admitReviewerRequest(config, model, next);
      if (!next || !nextAdmission?.ok || !audit("review.admission", {
        requestId: details.requestId, actionId: completedFacts.exactActionId,
        admitted: nextAdmission?.ok ?? false, evidenceContractVersion: next.evidenceContractVersion,
        evidenceDiagnostics: nextAdmission?.ok ? nextAdmission.dossier.evidenceDiagnostics : next.evidenceDiagnostics,
        ...auditContext,
      })) return unavailable("evidence", "The augmented reviewer request failed admission or audit.");
      activeDossier = nextAdmission.dossier;
      reviewedVersion = stamp(ownerSessionId, branchIds, config, activeDossier);
      if (!stillCurrent() || Date.now() >= deadline || deps.getSignal()?.aborted) return changed();
    }
    if (!outcome || outcome.kind !== "reviewed") return unavailable("investigation_budget", "The reviewer produced no bounded decision.");
    if (!stillCurrent() || Date.now() >= deadline || deps.getSignal()?.aborted) return changed();

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
        attempts: totalAttempts,
        durationMs: Date.now() - askStarted,
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
      if (!stillCurrent() || Date.now() >= deadline || deps.getSignal()?.aborted) return changed();
      prepared.commit();
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
      if (!stillCurrent() || Date.now() >= deadline || deps.getSignal()?.aborted) return changed();
      deps.lifecycle.recordNonDenial();
      prepared.commit();
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
    prepared.commit();
    if (denial.circuitBreaker) deps.onCircuitBreaker?.(denial.circuitBreaker);
    return {
      kind: "deny",
      source: "reviewer",
      reason: `${decision.rationale} ${NON_CIRCUMVENTION}`,
    };
  };
}
