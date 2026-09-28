import {
  caseIncludeToolResults,
  corpusDetails,
  providerUsage,
  publicFailureCode,
  redactPaths,
  reviewedSample,
  unavailableSample,
} from "./guardian-live-lib.mjs";

function replyText(reply) {
  if (!reply || !Array.isArray(reply.content)) return "";
  return reply.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * One inert corpus review. `complete` is the only model transport.
 * Corpus actions are never dispatched.
 */
export async function reviewCorpusCase({ revision, item, index, settings, backend, registry, complete }) {
  const includeToolResults = caseIncludeToolResults(item, settings);
  const config = revision.withDefaults({
    provider: settings.provider,
    model: settings.model,
    maxAttempts: settings.maxAttempts,
    includeToolResults,
    readOnlyProbes: false,
    investigationEnabled: false,
    timeoutMs: 90_000,
  });
  const dossier = revision.buildApprovalDossier({
    details: corpusDetails(item),
    evidence: item.entries,
    evidencePolicy: { includeToolResults },
  });
  if (!dossier) return unavailableSample(index, "evidence");
  let reply;
  const started = Date.now();
  const outcome = await revision.reviewDossier({
    dossier,
    config,
    backend,
    registry,
    complete: async (model, context, options) => {
      reply = await complete(model, context, options);
      return reply;
    },
  });
  const latencyMs = Date.now() - started;
  if (!outcome || outcome.kind !== "reviewed") {
    const detail = redactPaths(reply?.errorMessage || outcome?.message || "").slice(0, 300);
    if (detail) process.stderr.write(`unavailable ${publicFailureCode(outcome)}: ${detail}\n`);
    return unavailableSample(index, publicFailureCode(outcome));
  }
  const raw = revision.parseReviewerDecision(replyText(reply));
  if (!raw) return unavailableSample(index, "parse");
  return reviewedSample(index, raw, outcome.decision, latencyMs, providerUsage(reply));
}
