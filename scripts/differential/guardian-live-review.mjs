import {
  caseIncludeToolResults,
  corpusDetails,
  providerUsage,
  publicFailureCode,
  redactPaths,
  reviewedSample,
  sampleFromReviewFailure,
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
  if (!dossier) return sampleFromReviewFailure(index, "evidence");
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
    const code = publicFailureCode(outcome);
    const detail = redactPaths(reply?.errorMessage || outcome?.message || "").slice(0, 300);
    const sample = sampleFromReviewFailure(index, code);
    if (detail) process.stderr.write(`${sample.status} ${code}: ${detail}\n`);
    return sample;
  }
  const raw = revision.parseReviewerDecision(replyText(reply));
  if (!raw) return unavailableSample(index, "parse");
  return reviewedSample(index, raw, outcome.decision, latencyMs, providerUsage(reply));
}
