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

function splitLiteralShellChain(command: string): string[] | undefined {
  const leaves: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? undefined : quote ?? character;
      continue;
    }
    if (quote) continue;

    const separatorLength =
      character === ";" ? 1 : command.slice(index, index + 2).match(/^(?:&&|\|\|)$/)?.[0].length;
    if (!separatorLength) continue;

    const leaf = command.slice(start, index).trim();
    if (!leaf) return undefined;
    leaves.push(leaf);
    index += separatorLength - 1;
    start = index + 1;
  }

  if (quote || escaped) return undefined;
  const leaf = command.slice(start).trim();
  if (!leaf) return undefined;
  leaves.push(leaf);
  return leaves;
}

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

  const leaves = splitLiteralShellChain(command);
  if (!leaves) return undefined;
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

    const facts = details.delegatedApproval;
    if (!facts?.complete) {
      audit("review.failure", {
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

    if (
      facts.surface === "bash" &&
      facts.policy?.state === "ask" &&
      facts.policy?.matchedPattern === "<opaque-bash-wrapper>" &&
      typeof facts.action.command === "string"
    ) {
      const innerCommands = decomposeLiteralShellCommand(facts.action.command);
      if (innerCommands) {
        let everyLeafAllowed = true;
        for (const innerCommand of innerCommands) {
          const result = query.checkPermission(
            "bash",
            innerCommand,
            details.agentName ?? undefined,
          );
          if (result.state === "deny") {
            return {
              kind: "deny",
              reason:
                result.reason ??
                "A decomposed command is denied by recorded permission policy.",
            };
          }
          if (result.state !== "allow") everyLeafAllowed = false;
        }
        if (everyLeafAllowed) return { kind: "allow" };
      }
    }

    const override = deps.lifecycle.consumeOverride(facts.exactActionId);
    const dossier = buildApprovalDossier({
      details,
      evidence: deps.getEvidence(),
      evidencePolicy: { includeToolResults: config.includeToolResults },
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

    if (
      !audit("review.routed", {
        requestId: dossier.request.id,
        actionId: dossier.action.exactActionId,
        surface: dossier.action.surface,
        actionKind: dossier.action.action.kind,
        override: Boolean(override),
        evidence: dossier.evidence,
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
      audit("review.failure", {
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
      audit("review.failure", {
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
      audit("review.failure", {
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
      const audited = audit("review.decision", {
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

    const denial = deps.lifecycle.recordDenial({
      dossier,
      rationale: decision.rationale,
      riskLevel: decision.riskLevel,
    });
    audit("review.decision", {
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
