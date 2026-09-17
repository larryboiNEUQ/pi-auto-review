import type {
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";

import type { EvaluateJevFn } from "./jev-evaluation";
import { executeReviewer, resolveReviewerAuth, ReviewerBackendError, type ReviewerBackend } from "./reviewer-backend";

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
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAvailable?(): Model<any>[];
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getApiKeyAndHeaders?(model: Model<any>): Promise<ResolvedRequestAuth>;
}

export type ReviewOutcome =
  | { kind: "reviewed"; decision: ReviewerDecision; attempts: number; durationMs: number }
  | {
      kind: "failure";
      code: "auth" | "cancelled" | "model" | "parse" | "timeout" | "transport";
      message: string;
      attempts: number;
      durationMs: number;
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
  registry: ModelRegistryLike;
  complete: CompleteFn;
  signal?: AbortSignal;
}): Promise<ReviewOutcome> {
  const started = Date.now();
  const deadline = started + inputs.config.timeoutMs;
  let auth: Extract<ResolvedRequestAuth, { ok: true }> = { ok: true };
  {
    let resolved: ResolvedRequestAuth;
    const authController = new AbortController();
    const cancelAuth = () => authController.abort();
    const authTimer = setTimeout(cancelAuth, Math.max(0, deadline - Date.now()));
    inputs.signal?.addEventListener("abort", cancelAuth, { once: true });
    if (inputs.signal?.aborted) authController.abort();
    try {
      resolved = await abortable(resolveReviewerAuth(inputs.registry, inputs.backend, { allowLegacyUnauthenticated: true }), authController.signal);
    } catch (error) {
      return {
        kind: "failure",
        code: inputs.signal?.aborted ? "cancelled" : authController.signal.aborted ? "timeout" : "auth",
        message: inputs.signal?.aborted ? "Review cancelled." : authController.signal.aborted ? "Delegated review timed out." : "Reviewer authentication resolution failed; check Pi provider authentication.",
        attempts: 0,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(authTimer);
      inputs.signal?.removeEventListener("abort", cancelAuth);
    }
    if (!resolved.ok) {
      return { kind: "failure", code: "auth", message: resolved.error, attempts: 0, durationMs: Date.now() - started };
    }
    auth = resolved;
  }

  let lastCode: "model" | "parse" | "transport" = "model";
  let lastMessage = "Reviewer produced no decision.";
  for (let attempt = 1; attempt <= inputs.config.maxAttempts; attempt++) {
    if (inputs.signal?.aborted) {
      return { kind: "failure", code: "cancelled", message: "Review cancelled.", attempts: attempt - 1, durationMs: Date.now() - started };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { kind: "failure", code: "timeout", message: "Delegated review timed out; timeout is not evidence that the action is unsafe.", attempts: attempt - 1, durationMs: Date.now() - started };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    inputs.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const parsed = await abortable(executeReviewer({ ...inputs, auth, signal: controller.signal }), controller.signal);
      if (controller.signal.aborted) throw new Error("Review aborted.");
      if (!parsed) {
        lastCode = "parse";
        lastMessage = "Reviewer returned malformed structured output.";
        continue;
      }
      return {
        kind: "reviewed",
        decision: enforceGuardianThresholds(parsed),
        attempts: attempt,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (inputs.signal?.aborted) {
        return { kind: "failure", code: "cancelled", message: "Review cancelled.", attempts: attempt, durationMs: Date.now() - started };
      }
      if (controller.signal.aborted || Date.now() >= deadline) {
        return { kind: "failure", code: "timeout", message: "Delegated review timed out; timeout is not evidence that the action is unsafe.", attempts: attempt, durationMs: Date.now() - started };
      }
      lastCode = error instanceof ReviewerBackendError ? error.code : "transport";
      lastMessage = error instanceof ReviewerBackendError ? error.message : "Reviewer request failed.";
      logSafeAllow("review.retry", {
        actionId: inputs.dossier.action.exactActionId,
        attempt,
        code: lastCode,
      });
    } finally {
      clearTimeout(timer);
      inputs.signal?.removeEventListener("abort", onAbort);
    }
  }
  return {
    kind: "failure",
    code: lastCode,
    message: lastMessage,
    attempts: inputs.config.maxAttempts,
    durationMs: Date.now() - started,
  };
}
