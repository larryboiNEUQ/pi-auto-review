import { structuredHttpStatus, type BackendDiagnostic, type ReviewerDiagnostic, type ReviewFailureCode } from "./reviewer-diagnostic";
import type {
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";

import type { EvaluateJevFn, JevTransport, JevTransportResolution } from "./jev-evaluation";
import { admitReviewerRequest, estimateReviewerContextTokens, executeReviewer, requestLimitTokens, resolveReviewerAuth, ReviewerBackendError, type ReviewerBackend } from "./reviewer-backend";
import type { FactRequest } from "./investigation-broker";
import type { PreparedReview } from "./review-continuity";

import type { SafeAllowConfig } from "./config-schema";
import type { ApprovalDossier } from "./dossier";
import { logSafeAllow } from "./log";
import {
  enforceGuardianThresholds,
  type ReviewerDecision,
} from "./review-contract";

export type CompleteFn = (
  model: Model<any>,
  context: Context,
  options?: {
    signal?: AbortSignal;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  },
) => Promise<AssistantMessage>;

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; jevTransport?: JevTransport }
  | { ok: false; error: string };

export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAvailable?(): Model<any>[];
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getApiKeyAndHeaders?(model: Model<any>): Promise<ResolvedRequestAuth>;
  /**
   * Runtime completion channel. Unlike pi-ai/compat `complete`, which
   * dispatches by `model.api` through the api-provider registry — invisible to
   * extension-registered providers — this routes through the composed runtime
   * provider: it resolves auth and reaches extension `streamSimple`
   * implementations such as pi-devin-local. Optional for test doubles.
   */
  complete?(model: Model<any>, context: Context, options?: Parameters<CompleteFn>[2]): Promise<AssistantMessage>;
}

export type ReviewOutcome =
  | {
      kind: "reviewed";
      decision: ReviewerDecision;
      attempts: number;
      durationMs: number;
      /** Present only when the backend response carried provider usage. */
      usage?: Record<string, number | { total: number }>;
    }
  | { kind: "fact-request"; request: FactRequest; attempts: number; durationMs: number }
  | {
      kind: "failure";
      code: ReviewFailureCode;
      message: string;
      attempts: number;
      durationMs: number;
      diagnostic: ReviewerDiagnostic;
    };

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Review aborted."));
    if (signal.aborted) { operation.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function reviewDossier(inputs: {
  dossier: ApprovalDossier;
  config: SafeAllowConfig;
  backend: ReviewerBackend;
  evaluate?: EvaluateJevFn;
  jevResolution?: JevTransportResolution;
  registry: ModelRegistryLike;
  complete: CompleteFn;
  signal?: AbortSignal;
  prepared?: PreparedReview;
  deadlineMs?: number;
  /** Revalidate ask/policy after async auth and immediately before inference. */
  isCurrent?: () => boolean;
  attempts?: number;
  audit?: typeof logSafeAllow;
}): Promise<ReviewOutcome> {
  const started = Date.now();
  const audit = inputs.audit ?? logSafeAllow;
  const diagnostic = (code: ReviewFailureCode, attempt: number, observed?: BackendDiagnostic): ReviewerDiagnostic => ({
    ...(observed ?? { source: code === "auth" ? "authentication" : "review", classification: code }),
    attempt, provider: inputs.backend.provider, model: inputs.backend.id, backend: inputs.backend.kind,
    durationMs: Date.now() - started,
  });
  const failure = (code: ReviewFailureCode, message: string, attempts: number, observed?: ReviewerDiagnostic): ReviewOutcome => ({
    kind: "failure", code, message, attempts, durationMs: Date.now() - started,
    diagnostic: observed ?? diagnostic(code, attempts),
  });
  const deadline = Math.min(started + inputs.config.timeoutMs, inputs.deadlineMs ?? Number.POSITIVE_INFINITY);
  if (inputs.signal?.aborted) return failure("cancelled", "Review cancelled.", 0);
  if (deadline <= Date.now()) return failure("timeout", "Delegated review timed out; timeout is not evidence that the action is unsafe.", 0);
  const admission = admitReviewerRequest(inputs.config, inputs.backend, inputs.dossier);
  if (!admission.ok) return failure("evidence", admission.reason, 0);
  if (inputs.backend.kind === "chat" && inputs.prepared?.context &&
    (requestLimitTokens(inputs.backend) === undefined ||
      estimateReviewerContextTokens(inputs.prepared.context) > requestLimitTokens(inputs.backend)!)) {
    return failure("evidence", "Prepared reviewer context exceeds the admitted request budget.", 0);
  }
  const admittedInputs = { ...inputs, dossier: admission.dossier };
  let auth: Extract<ResolvedRequestAuth, { ok: true }> = { ok: true };
  {
    let resolved: ResolvedRequestAuth;
    const authController = new AbortController();
    const cancelAuth = () => authController.abort();
    const authTimer = setTimeout(cancelAuth, Math.max(0, deadline - Date.now()));
    inputs.signal?.addEventListener("abort", cancelAuth, { once: true });
    if (inputs.signal?.aborted) authController.abort();
    try {
      resolved = await abortable(resolveReviewerAuth(inputs.registry, inputs.backend, { allowLegacyUnauthenticated: true, jevResolution: inputs.jevResolution }), authController.signal);
    } catch (error) {
      const code = inputs.signal?.aborted ? "cancelled" : authController.signal.aborted ? "timeout" : "auth";
      const httpStatus = code === "auth" ? structuredHttpStatus(error) : undefined;
      return failure(
        code,
        inputs.signal?.aborted ? "Review cancelled." : authController.signal.aborted ? "Delegated review timed out." : "Reviewer authentication resolution failed; check Pi provider authentication.",
        0,
        httpStatus === undefined ? undefined : diagnostic(code, 0, { source: "authentication", classification: code, httpStatus }),
      );
    } finally {
      clearTimeout(authTimer);
      inputs.signal?.removeEventListener("abort", cancelAuth);
    }
    if (!resolved.ok) {
      return failure("auth", resolved.error, 0);
    }
    auth = resolved;
  }

  let lastCode: "model" | "parse" | "transport" = "model";
  let lastMessage = "Reviewer produced no decision.";
  let lastDiagnostic: ReviewerDiagnostic | undefined;
  const maxAttempts = inputs.attempts ?? inputs.config.maxAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (inputs.signal?.aborted) {
      return failure("cancelled", "Review cancelled.", attempt - 1);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return failure("timeout", "Delegated review timed out; timeout is not evidence that the action is unsafe.", attempt - 1);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    inputs.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      if (inputs.isCurrent) {
        let current = false;
        try { current = inputs.isCurrent(); } catch { /* A failed guard must not disclose evidence. */ }
        if (!current) return failure("authorization_changed", "Reviewer context or fact permission changed before inference.", attempt - 1);
      }
      if (controller.signal.aborted || inputs.signal?.aborted || Date.now() >= deadline) throw new Error("Review deadline or cancellation reached.");
      const parsed = await abortable(executeReviewer({ ...admittedInputs, context: inputs.prepared?.context, auth, signal: controller.signal }), controller.signal);
      if (controller.signal.aborted || inputs.signal?.aborted || Date.now() >= deadline) throw new Error("Review deadline or cancellation reached.");
      if (!parsed) throw new ReviewerBackendError("parse", inputs.backend.kind);
      if (parsed.kind === "decision") return {
        kind: "reviewed",
        decision: enforceGuardianThresholds(parsed.decision),
        attempts: attempt,
        durationMs: Date.now() - started,
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      };
      return { kind: "fact-request", request: parsed.request, attempts: attempt, durationMs: Date.now() - started };
    } catch (error) {
      if (inputs.signal?.aborted) {
        return failure("cancelled", "Review cancelled.", attempt);
      }
      if (controller.signal.aborted || Date.now() >= deadline) {
        return failure("timeout", "Delegated review timed out; timeout is not evidence that the action is unsafe.", attempt);
      }
      lastCode = error instanceof ReviewerBackendError ? error.code : "transport";
      lastMessage = error instanceof ReviewerBackendError ? error.message : "Reviewer request failed.";
      const httpStatus = structuredHttpStatus(error);
      const observed: BackendDiagnostic = error instanceof ReviewerBackendError ? error.diagnostic : {
        source: inputs.backend.kind, classification: "transport", ...(httpStatus === undefined ? {} : { httpStatus }),
      };
      lastDiagnostic = diagnostic(lastCode, attempt, observed);
      let audited = false;
      try {
        audited = audit("review.retry", {
          actionId: inputs.dossier.action.exactActionId, attempt, code: lastCode, diagnostic: lastDiagnostic,
        });
      } catch {}
      if (!audited) return failure("audit", "Reviewer diagnostic audit failed.", attempt);
    } finally {
      clearTimeout(timer);
      inputs.signal?.removeEventListener("abort", onAbort);
    }
  }
  return failure(lastCode, lastMessage, maxAttempts, lastDiagnostic);
}
