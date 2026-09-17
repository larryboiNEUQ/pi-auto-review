import type { SafeAllowConfig } from "./config-schema";
import type { ApprovalDossier } from "./dossier";
import { parseReviewerDecision, type ReviewerDecision } from "./review-contract";
import { secretSafeJson } from "./redaction";
import type { AssistantMessage, Context, TextContent, Model } from "@earendil-works/pi-ai";
import type { CompleteFn, ModelRegistryLike, ResolvedRequestAuth } from "./model-review";
import { evaluateJev, jevState, JEV_QUESTIONS, parseJevDecision, type EvaluateJevFn, JEV_CONTRACT_VERSION, JEV_MODEL, JEV_PROVIDER } from "./jev-evaluation";

export type ReviewerBackend =
  | { kind: "chat"; provider: string; id: string; model: Model<any> }
  | { kind: "evaluation"; provider: string; id: string; contractVersion: string };
export const jevReviewer: ReviewerBackend = {
  kind: "evaluation", provider: JEV_PROVIDER, id: JEV_MODEL, contractVersion: JEV_CONTRACT_VERSION,
};
export function resolveReviewerBackend(registry: ModelRegistryLike, provider: string, id: string): ReviewerBackend | undefined {
  if (provider === JEV_PROVIDER && id === JEV_MODEL) return jevReviewer;
  const model = registry.find(provider, id);
  return model ? { kind: "chat", provider, id, model } : undefined;
}
export function listReviewerBackends(registry: ModelRegistryLike, scopedModels?: readonly Model<any>[]): ReviewerBackend[] {
  const models = scopedModels?.length ? scopedModels : registry.getAvailable?.() ?? [];
  return [...models.filter((model) => !(model.provider === JEV_PROVIDER && model.id === JEV_MODEL))
    .map((model): ReviewerBackend => ({ kind: "chat", provider: model.provider, id: model.id, model })), jevReviewer];
}
export async function resolveReviewerAuth(registry: ModelRegistryLike, backend: ReviewerBackend, options: { allowLegacyUnauthenticated?: boolean } = {}): Promise<ResolvedRequestAuth> {
  if (backend.kind === "evaluation") {
    if (!registry.getApiKeyForProvider) return { ok: false, error: "Reviewer authentication requires Pi's public provider-auth API; update Pi to a compatible version." };
    const apiKey = await registry.getApiKeyForProvider(backend.provider);
    return typeof apiKey === "string" && apiKey.trim()
      ? { ok: true, apiKey }
      : { ok: false, error: "Reviewer authentication is unavailable; configure Vercel AI Gateway authentication in Pi." };
  }
  return registry.getApiKeyAndHeaders
    ? registry.getApiKeyAndHeaders(backend.model)
    : options.allowLegacyUnauthenticated ? { ok: true } : { ok: false, error: "Reviewer authentication cannot be resolved." };
}

function extractText(reply: AssistantMessage): string {
  if (!reply || !Array.isArray(reply.content)) return "";
  return reply.content
    .filter((part): part is TextContent => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function reviewerContext(config: SafeAllowConfig, dossier: ApprovalDossier): Context {
  return {
    systemPrompt: [config.instructions, "# Operator Guardian policy", config.policy].join(
      "\n\n",
    ),
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


export class ReviewerBackendError extends Error {
  constructor(readonly code: "model" | "parse" | "transport", message: string) { super(message); }
}
export async function executeReviewer(inputs: {
  backend: ReviewerBackend; config: SafeAllowConfig; dossier: ApprovalDossier;
  auth: Extract<ResolvedRequestAuth, { ok: true }>; signal: AbortSignal;
  complete: CompleteFn; evaluate?: EvaluateJevFn;
}): Promise<ReviewerDecision | null> {
  if (inputs.backend.kind === "evaluation") {
    try {
      const result = await (inputs.evaluate ?? evaluateJev)({ apiKey: inputs.auth.apiKey!,
        state: jevState(inputs.config, inputs.dossier), questions: JEV_QUESTIONS, signal: inputs.signal });
      return parseJevDecision(result);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (["AI_InvalidResponseDataError", "AI_TypeValidationError", "AI_JSONParseError"].includes(name)) {
        throw new ReviewerBackendError("parse", "Reviewer returned malformed structured output.");
      }
      throw new ReviewerBackendError("transport", "Reviewer evaluation request failed; check Gateway service, quota, and authentication.");
    }
  }
  const reply = await inputs.complete(inputs.backend.model, reviewerContext(inputs.config, inputs.dossier), {
    ...inputs.auth, signal: inputs.signal,
  });
  if (reply.stopReason === "aborted" || reply.stopReason === "error") {
    throw new ReviewerBackendError("model", reply.stopReason === "aborted" ? "Reviewer aborted." : String(reply.errorMessage ?? "Reviewer session failed."));
  }
  return parseReviewerDecision(extractText(reply));
}
