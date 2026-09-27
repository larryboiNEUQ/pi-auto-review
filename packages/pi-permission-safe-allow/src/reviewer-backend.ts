import type { SafeAllowConfig } from "./config-schema";
import type { ApprovalDossier, DossierEvidence } from "./dossier";
import { parseReviewerDecision, type ReviewerDecision } from "./review-contract";
import { secretSafeJson } from "./redaction";
import type { AssistantMessage, Context, TextContent, Model } from "@earendil-works/pi-ai";
import type { CompleteFn, ModelRegistryLike, ResolvedRequestAuth } from "./model-review";
import {
  evaluateJev,
  jevState,
  JEV_QUESTIONS,
  parseJevDecision,
  resolveJevTransport,
  JevEvaluationError,
  type EvaluateJevFn,
  JEV_CONTRACT_VERSION,
  JEV_MODEL,
  JEV_PROVIDER,
} from "./jev-evaluation";

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
    const { transport, typesafeApiKey } = resolveJevTransport();
    if (transport === "official") {
      return typesafeApiKey
        ? { ok: true, apiKey: typesafeApiKey }
        : {
            ok: false,
            error:
              "Reviewer authentication is unavailable; set TYPESAFE_API_KEY for the official TypeSafe Jev API (or unset SAFE_ALLOW_JEV_TRANSPORT=official to use Gateway).",
          };
    }
    if (!registry.getApiKeyForProvider) return { ok: false, error: "Reviewer authentication requires Pi's public provider-auth API; update Pi to a compatible version." };
    const apiKey = await registry.getApiKeyForProvider(backend.provider);
    return typeof apiKey === "string" && apiKey.trim()
      ? { ok: true, apiKey }
      : { ok: false, error: "Reviewer authentication is unavailable; configure Vercel AI Gateway authentication in Pi, or set TYPESAFE_API_KEY for the official TypeSafe API." };
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

/** Conservative, tokenizer-independent admission estimate. ASCII is charged at two
 * characters/token, non-ASCII at four tokens/code point (at least its UTF-8 bytes).
 * Jev's local cap is not a claim about its undisclosed provider window. */
export const JEV_REQUEST_CAP_TOKENS = 24_000;
const CHAT_OUTPUT_RESERVE = 2_000;
const OMISSION_MARKER = "[Reviewer admission omitted older optional non-user evidence to fit the request budget; see evidenceDiagnostics.]";
export type Admission = { ok: true; dossier: ApprovalDossier } | { ok: false; reason: string };
function renderedRequest(config: SafeAllowConfig, backend: ReviewerBackend, dossier: ApprovalDossier): string {
  if (backend.kind === "chat") return JSON.stringify(reviewerContext(config, dossier));
  // Both evaluation transports send the serialized state and typed questions.
  return JSON.stringify({ state: jevState(config, dossier), questions: JEV_QUESTIONS });
}
export function estimateReviewerContextTokens(context: Context): number {
  return estimateTokens(JSON.stringify(context));
}
function estimateTokens(payload: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of payload) {
    if (character.codePointAt(0)! < 128) ascii++;
    else nonAscii += 4;
  }
  return Math.ceil(ascii / 2) + nonAscii;
}
export function estimateReviewerRequestTokens(config: SafeAllowConfig, backend: ReviewerBackend, dossier: ApprovalDossier): number {
  return estimateTokens(renderedRequest(config, backend, dossier));
}
export function requestLimitTokens(backend: ReviewerBackend): number | undefined {
  if (backend.kind === "evaluation") return JEV_REQUEST_CAP_TOKENS;
  const window = backend.model.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0 || !Number.isInteger(window)) return undefined;
  const maxTokens = backend.model.maxTokens;
  const reserve = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.max(CHAT_OUTPUT_RESERVE, maxTokens) : CHAT_OUTPUT_RESERVE;
  return Math.max(0, window - reserve);
}
export function admitReviewerRequest(config: SafeAllowConfig, backend: ReviewerBackend, dossier: ApprovalDossier): Admission {
  // Selector omissions/truncations are not semantically ranked, especially for user text.
  const omissions = dossier.evidenceDiagnostics.omissionCounts;
  if (dossier.evidence.some((entry) => (entry.category === "user" || entry.category === "system") && entry.truncated) ||
    ["user_message_limit", "user_budget", "user_budget_truncation", "user_unsupported_content", "compacted_user_history", "edited_context_history", "system_budget", "system_entry_truncation"].some((reason) => (omissions[reason] ?? 0) > 0)) {
    return { ok: false, reason: "Selected evidence omitted or truncated mandatory user/system history; relevance cannot be established safely." };
  }
  const limit = requestLimitTokens(backend);
  if (limit === undefined) return { ok: false, reason: "Reviewer model context limit is unavailable; request admission failed closed." };
  let next = dossier;
  while (estimateReviewerRequestTokens(config, backend, next) > limit) {
    const optional = next.evidence.findIndex((e) => e.provenance === "assistant" || e.provenance === "tool-fact");
    if (optional < 0) return { ok: false, reason: "Mandatory reviewer request exceeds the admitted request budget." };
    const removed = next.evidence[optional]!;
    // An orphaned call/result is misleading even when both are only facts.
    const evidence = next.evidence.filter((entry, index) => index !== optional &&
      !(removed.callId && entry.callId === removed.callId && (entry.category === "tool_call" || entry.category === "tool_result")));
    const removedCount = next.evidence.length - evidence.length;
    const previous = next.evidenceDiagnostics;
    next = { ...next, evidence, evidenceDiagnostics: { ...previous, omittedEntries: previous.omittedEntries + removedCount, omissionReasons: [...new Set([...previous.omissionReasons, "review_request_budget"])].sort(), omissionCounts: { ...previous.omissionCounts, review_request_budget: (previous.omissionCounts.review_request_budget ?? 0) + removedCount } } };
  }
  if (next !== dossier) {
    // Marker is part of the measured payload and makes admission-time loss visible.
    const marker: DossierEvidence = { category: "system", role: "system", provenance: "system", truncated: false, text: OMISSION_MARKER };
    next = { ...next, evidence: [...next.evidence, marker] };
    if (estimateReviewerRequestTokens(config, backend, next) > limit) return { ok: false, reason: "Mandatory reviewer request exceeds the admitted request budget after omission marker." };
  }
  return { ok: true, dossier: next };
}

export function reviewerContext(config: SafeAllowConfig, dossier: ApprovalDossier): Context {
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
  backend: ReviewerBackend; config: SafeAllowConfig; dossier: ApprovalDossier; context?: Context;
  auth: Extract<ResolvedRequestAuth, { ok: true }>; signal: AbortSignal;
  complete: CompleteFn; evaluate?: EvaluateJevFn;
}): Promise<ReviewerDecision | null> {
  if (inputs.backend.kind === "evaluation") {
    try {
      const { transport } = resolveJevTransport();
      const result = await (inputs.evaluate ?? evaluateJev)({
        apiKey: inputs.auth.apiKey!,
        state: jevState(inputs.config, inputs.dossier),
        questions: JEV_QUESTIONS,
        signal: inputs.signal,
        transport,
      });
      return parseJevDecision(result);
    } catch (error) {
      if (error instanceof ReviewerBackendError) throw error;
      if (error instanceof JevEvaluationError) {
        throw new ReviewerBackendError(error.code, error.message);
      }
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError") throw error;
      if (["AI_InvalidResponseDataError", "AI_TypeValidationError", "AI_JSONParseError"].includes(name)) {
        throw new ReviewerBackendError("parse", "Reviewer returned malformed structured output.");
      }
      throw new ReviewerBackendError(
        "transport",
        "Reviewer evaluation request failed; check Gateway or TypeSafe service, quota, and authentication.",
      );
    }
  }
  const reply = await inputs.complete(inputs.backend.model, inputs.context ?? reviewerContext(inputs.config, inputs.dossier), {
    ...inputs.auth, signal: inputs.signal,
  });
  if (reply.stopReason === "aborted" || reply.stopReason === "error") {
    throw new ReviewerBackendError("model", reply.stopReason === "aborted" ? "Reviewer aborted." : String(reply.errorMessage ?? "Reviewer session failed."));
  }
  return parseReviewerDecision(extractText(reply));
}
