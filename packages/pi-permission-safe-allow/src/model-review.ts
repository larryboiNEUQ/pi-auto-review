import type {
  AssistantMessage,
  Context,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";

import type { SafeAllowConfig } from "./config-schema";
import type { ApprovalDossier } from "./dossier";
import { logSafeAllow } from "./log";
import {
  enforceGuardianThresholds,
  parseReviewerDecision,
  type ReviewerDecision,
} from "./review-contract";
import { secretSafeJson } from "./redaction";

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

function extractText(reply: AssistantMessage): string {
  if (!reply || !Array.isArray(reply.content)) return "";
  return reply.content
    .filter((part): part is TextContent => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function reviewerContext(config: SafeAllowConfig, dossier: ApprovalDossier): Context {
  return {
    systemPrompt: config.instructions,
    messages: [
      {
        role: "user",
        content: [
          "Review this exact Pi approval dossier.",
          secretSafeJson(dossier),
          "Reply with strict JSON fields: riskLevel, userAuthorization, verdict, rationale, scope, absoluteDeny.",
        ].join("\n\n"),
        timestamp: Date.now(),
      },
    ],
  };
}

export async function reviewDossier(inputs: {
  dossier: ApprovalDossier;
  config: SafeAllowConfig;
  model: Model<any>;
  registry: ModelRegistryLike;
  complete: CompleteFn;
  signal?: AbortSignal;
}): Promise<ReviewOutcome> {
  const started = Date.now();
  const deadline = started + inputs.config.timeoutMs;
  let auth: Extract<ResolvedRequestAuth, { ok: true }> = { ok: true };
  if (typeof inputs.registry.getApiKeyAndHeaders === "function") {
    let resolved: ResolvedRequestAuth;
    try {
      resolved = await inputs.registry.getApiKeyAndHeaders(inputs.model);
    } catch (error) {
      return {
        kind: "failure",
        code: "auth",
        message: error instanceof Error ? error.message : String(error),
        attempts: 0,
        durationMs: Date.now() - started,
      };
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
      const reply = await inputs.complete(
        inputs.model,
        reviewerContext(inputs.config, inputs.dossier),
        {
          signal: controller.signal,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
        },
      );
      const stopReason = String(reply.stopReason ?? "");
      if (stopReason === "aborted") {
        if (Date.now() >= deadline) {
          return { kind: "failure", code: "timeout", message: "Delegated review timed out; timeout is not evidence that the action is unsafe.", attempts: attempt, durationMs: Date.now() - started };
        }
        lastCode = "model";
        lastMessage = "Reviewer aborted.";
        continue;
      }
      if (stopReason === "error") {
        lastCode = "model";
        lastMessage = String(reply.errorMessage ?? "Reviewer session failed.");
        continue;
      }
      const parsed = parseReviewerDecision(extractText(reply));
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
      if (Date.now() >= deadline) {
        return { kind: "failure", code: "timeout", message: "Delegated review timed out; timeout is not evidence that the action is unsafe.", attempts: attempt, durationMs: Date.now() - started };
      }
      lastCode = "transport";
      lastMessage = error instanceof Error ? error.message : String(error);
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
