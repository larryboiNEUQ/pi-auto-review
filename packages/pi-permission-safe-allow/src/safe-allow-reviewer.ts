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
import { admitReviewerRequest, resolveReviewerBackend } from "./reviewer-backend";
import { ReviewerContinuity } from "./review-continuity";
import { resolveJevTransport, type EvaluateJevFn } from "./jev-evaluation";
import { runReadOnlyProbes } from "./read-only-probes";

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
  getBatchProvenance?: (toolCallId: string) => "single" | "multiple" | "unknown";
  continuity?: ReviewerContinuity;
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

/** Pi persists the assistant message before preparing its tool-call batch. Its
 * parallel dispatcher waits for every ask before executing any prepared call.
 * A missing matching host message is NOT proof of a single-call batch. */
function toolBatchProvenance(entries: readonly unknown[], toolCallId: string): "single" | "multiple" | "unknown" {
  // A tool-call ID can be reused across turns. Only the current assistant
  // message, with no newer user/result/assistant turn, can attest this batch.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const wrapper = entry as { type?: unknown; message?: unknown; role?: unknown; content?: unknown };
    const message = wrapper.type === "message" ? wrapper.message : wrapper.type === undefined ? wrapper : undefined;
    if (!message || typeof message !== "object") continue;
    const assistant = message as { role?: unknown; content?: unknown };
    if (assistant.role === "user" || assistant.role === "toolResult" || assistant.role === "tool") return "unknown";
    if (assistant.role !== "assistant") continue;
    if (!Array.isArray(assistant.content)) return "unknown";
    const calls = assistant.content.filter((part: unknown): part is { type: "toolCall"; id?: unknown } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
    if (!calls.length) return "unknown";
    if (!calls.some((call) => call.id === toolCallId)) return "unknown";
    return calls.length === 1 ? "single" : "multiple";
  }
  return "unknown";
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
    const auditContext = {
      policyVersion: GUARDIAN_POLICY_VERSION,
      policyHash: createHash("sha256").update(config.policy, "utf8").digest("hex"),
      probeUsed: false,
    };
    if (deps.hasPendingMessages?.()) {
      audit("review.failure", { requestId: details.requestId, code: "authorization_changed", reason: "pending_user_input", ...auditContext });
      return { kind: "deny", reason: failureReason("authorization_changed", "Pending user input must be resolved before this action is reviewed.") };
    }
    // Forwarding lacks child batch identity and the parent's branch is not the
    // child's source transcript. Issue #50 may add trusted child proof; until
    // then never infer single-call safety from a parent's unrelated history.
    const batchProvenance = details.forwarding || !details.toolCallId
      ? "unknown"
      : deps.getBatchProvenance?.(details.toolCallId) ?? toolBatchProvenance(deps.getEvidence(), details.toolCallId);
    if (batchProvenance !== "single") {
      audit("review.failure", { requestId: details.requestId, actionId: details.delegatedApproval?.exactActionId,
        code: "batch_release_unfenced", provenance: batchProvenance, ...auditContext });
      return { kind: "deny", reason: failureReason("batch_release_unfenced", "This Pi runtime cannot prove that the delegated ask is a single tool call at the executor seam; retry it alone in the originating session.") };
    }

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
        evidenceContractVersion: dossier.evidenceContractVersion,
        evidenceDiagnostics: dossier.evidenceDiagnostics,
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

    const admission = admitReviewerRequest(config, model, dossier);
    if (!audit("review.admission", {
      requestId: dossier.request.id,
      actionId: dossier.action.exactActionId,
      admitted: admission.ok,
      evidenceContractVersion: dossier.evidenceContractVersion,
      evidenceDiagnostics: admission.ok ? admission.dossier.evidenceDiagnostics : dossier.evidenceDiagnostics,
      ...auditContext,
    })) {
      return { kind: "deny", reason: failureReason("audit", "The request admission audit could not be written.") };
    }
    if (!admission.ok) {
      audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId, code: "evidence", ...auditContext });
      return { kind: "deny", reason: failureReason("evidence", admission.reason) };
    }
    const prepared = continuity.prepare({ ownerSessionId, branchIds, backend: model, config, dossier: admission.dossier });
    if (!audit("review.continuity", {
      requestId: dossier.request.id, actionId: dossier.action.exactActionId,
      mode: prepared.mode, reason: prepared.reason, ...auditContext,
    })) return { kind: "deny", reason: failureReason("audit", "The continuity audit could not be written.") };
    const reviewedVersion = createHash("sha256").update(JSON.stringify({
      ownerSessionId, branchIds, config,
      evidence: admission.dossier.evidence, diagnostics: admission.dossier.evidenceDiagnostics,
    })).digest("hex");

    let outcome;
    try {
      outcome = await reviewDossier({
        dossier: admission.dossier,
        config,
        backend: model,
        evaluate: deps.evaluate,
        registry,
        complete: deps.complete,
        signal: deps.getSignal(),
        prepared,
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
    // Approval is scoped to the exact admitted branch, policy, and facts. A
    // user revocation, branch switch, concurrent tool receipt, or model change
    // while the reviewer was in flight must not release the older decision.
    const currentConfig = deps.getConfig();
    const currentOwner = deps.getOwnerSessionId?.();
    const currentBranch = deps.getBranchIds?.();
    const fresh = currentConfig && buildApprovalDossier({
      details, evidence: deps.getEvidence(),
      evidencePolicy: { includeToolResults: currentConfig.includeToolResults, ownerSessionId: currentOwner },
      override, completedAction: completedFacts, probeEvidence,
    });
    const freshAdmission = fresh && currentConfig && admitReviewerRequest(currentConfig, model, fresh);
    const currentVersion = freshAdmission?.ok && createHash("sha256").update(JSON.stringify({
      ownerSessionId: currentOwner, branchIds: currentBranch, config: currentConfig,
      evidence: freshAdmission.dossier.evidence, diagnostics: freshAdmission.dossier.evidenceDiagnostics,
    })).digest("hex");
    if (deps.hasPendingMessages?.() || !currentVersion || currentVersion !== reviewedVersion) {
      audit("review.failure", { requestId: dossier.request.id, actionId: dossier.action.exactActionId,
        code: "authorization_changed", ...auditContext });
      return { kind: "deny", reason: failureReason("authorization_changed", "Pending user input, session, branch, effective policy, or admitted evidence changed during review; retry under current authority.") };
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
      prepared.commit();
      return { kind: "defer" };
    }

    const denial = deps.lifecycle.recordDenial({
      dossier,
      rationale: decision.rationale,
      riskLevel: decision.riskLevel,
    });
    if (auditDecision({
      denialId: denial.record.denialId,
      escalated: false,
      circuitBreaker: denial.circuitBreaker,
    })) prepared.commit();
    if (denial.circuitBreaker) deps.onCircuitBreaker?.(denial.circuitBreaker);
    return {
      kind: "deny",
      reason: `${decision.rationale} ${NON_CIRCUMVENTION}`,
    };
  };
}
