#!/usr/bin/env node
// Explicit opt-in Jev live run over the #51 synthetic corpus (candidate only).
// Corpus actions are never executed. Secrets are never printed.
// Usage: SAFE_ALLOW_JEV_LIVE=1 node scripts/differential/jev-live.mjs <auto|official|gateway> <repeats> <outDir> [caseIdFilter]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
if (process.env.SAFE_ALLOW_JEV_LIVE !== "1") throw new Error("Set SAFE_ALLOW_JEV_LIVE=1 to opt in to paid live inference.");
const lib = await import(pathToFileURL(join(root, "scripts/differential/guardian-live-lib.mjs")).href);
const { validateGuardianCorpus } = await import(pathToFileURL(join(root, "scripts/differential/guardian-corpus.mjs")).href);
const { resolveHostPiCodingAgent } = await import(pathToFileURL(join(root, "scripts/lib/resolve-host-pi-coding-agent.mjs")).href);

const [transport, repeatsArg, outDir, filter] = process.argv.slice(2);
if (!["official", "gateway", "auto"].includes(transport)) throw new Error("transport must be official|gateway|auto");
if (!outDir) throw new Error("output directory is required");
const repeats = Number(repeatsArg ?? 1);
const MAX_CALLS = 200;
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
if (transport === "auto") delete process.env.SAFE_ALLOW_JEV_TRANSPORT;
else process.env.SAFE_ALLOW_JEV_TRANSPORT = transport;

// Same bundling approach as guardian-live-revision.mjs, plus the Jev exports.
const srcDir = join(root, "packages/pi-permission-safe-allow/src");
const nodeModules = join(root, "node_modules");
const permissionSrc = join(nodeModules, "@gotgenes/pi-permission-system/src");
const { existsSync } = await import("node:fs");
const resolveTs = (p) => [p, `${p}.ts`, `${p}.js`, join(p, "index.ts")].find(existsSync) ?? `${p}.ts`;
const built = await esbuild.build({
  stdin: {
    contents: `
export { GUARDIAN_POLICY_VERSION, withDefaults } from "./config-schema.ts";
export { buildApprovalDossier } from "./dossier.ts";
export { reviewDossier } from "./model-review.ts";
export { jevReviewer } from "./reviewer-backend.ts";
export { evaluateJev, parseJevDecision, resolveJevTransport, JEV_CONTRACT_VERSION } from "./jev-evaluation.ts";
`, resolveDir: srcDir, sourcefile: "jev-entry.ts", loader: "ts" },
  bundle: true, platform: "node", format: "esm", target: "node22", write: false,
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "@earendil-works/pi-coding-agent", "ai"],
  nodePaths: [nodeModules], logLevel: "silent",
  plugins: [{ name: "alias", setup(b) {
    b.onResolve({ filter: /^@gotgenes\/pi-permission-system$/ }, () => ({ path: join(permissionSrc, "authority/delegated-approval-facts.ts") }));
    b.onResolve({ filter: /^#src\// }, (a) => ({ path: resolveTs(join(permissionSrc, a.path.slice(5))) }));
  } }],
});
await mkdir(join(root, "artifacts/guardian-live-bundles"), { recursive: true });
const bundlePath = join(root, "artifacts/guardian-live-bundles/candidate-jev.mjs");
await writeFile(bundlePath, built.outputFiles[0].text);
const rev = await import(pathToFileURL(bundlePath).href);

const sdkPath = await resolveHostPiCodingAgent({ locatePiBin: async () => "pi" });
const host = await import(pathToFileURL(sdkPath).href);
const runtime = await host.ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
const registry = new host.ModelRegistry(runtime);

const corpusBytes = await readFile(join(root, "packages/pi-permission-safe-allow/evaluation/corpus-v1.json"));
let cases = validateGuardianCorpus(JSON.parse(corpusBytes.toString("utf8")));
if (filter) cases = cases.filter((c) => c.id.includes(filter));
if (cases.length === 0) throw new Error("case filter selected no cases");
if (cases.length * repeats > MAX_CALLS) throw new Error("requested run exceeds the 200-call cap");

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const settings = { backend: "evaluation", provider: "vercel-ai-gateway", model: "typesafe-ai/jev", transport,
  officialModel: transport === "official" ? (process.env.TYPESAFE_JEV_MODEL || "jev-latest") : null,
  repeats, maxAttempts: 1, includeToolResults: true, readOnlyProbes: false, investigationEnabled: false };
let calls = 0;
const results = [];
for (const item of cases) {
  const repeatsOut = [];
  for (let index = 1; index <= repeats; index++) {
    if (calls >= MAX_CALLS) throw new Error("hard cap reached");
    const includeToolResults = lib.caseIncludeToolResults(item, settings);
    const config = rev.withDefaults({ provider: settings.provider, model: settings.model, maxAttempts: 1,
      includeToolResults, readOnlyProbes: false, investigationEnabled: false, timeoutMs: 90_000 });
    const dossier = rev.buildApprovalDossier({ details: lib.corpusDetails(item), evidence: item.entries, evidencePolicy: { includeToolResults } });
    if (!dossier) { repeatsOut.push(lib.sampleFromReviewFailure(index, "evidence")); continue; }
    let rawResult;
    const started = Date.now();
    const outcome = await rev.reviewDossier({
      dossier, config, backend: rev.jevReviewer, registry,
      complete: async () => { throw new Error("chat path must not be used"); },
      evaluate: async (req) => { calls++; rawResult = await rev.evaluateJev(req); return rawResult; },
    });
    const latencyMs = Date.now() - started;
    let sample;
    if (!outcome || outcome.kind !== "reviewed") {
      const code = lib.publicFailureCode(outcome);
      sample = lib.sampleFromReviewFailure(index, code);
      sample.detail = lib.redactPaths(outcome?.message ?? "").slice(0, 300);
      // Raw provider responses are intentionally not written to the artifact.
    } else {
      const raw = rev.parseJevDecision(rawResult);
      sample = lib.reviewedSample(index, raw, outcome.decision, latencyMs, rawResult?.usage ?? null);
      sample.explanationCategory = rawResult?.answers?.explanationCategory?.choice;
      sample.verdictProbabilities = rawResult?.answers?.verdict?.probabilities ?? null;
      sample.responseModel = rawResult?.model ?? rawResult?.modelId ?? null;
    }
    repeatsOut.push(sample);
    process.stdout.write(`${item.id} #${index} expected=${item.expectedAutomatic} -> ${sample.status === "reviewed" ? `${sample.final.route} (${sample.raw.riskLevel}/${sample.raw.userAuthorization}/${sample.raw.scope}) ${latencyMs}ms` : `${sample.status}:${sample.code} ${sample.detail ?? ""}`}\n`);
  }
  results.push({ id: item.id, group: item.group, expectedAutomatic: item.expectedAutomatic, repeats: repeatsOut });
}
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `jev-${transport}.json`), `${JSON.stringify({ commit, policyVersion: rev.GUARDIAN_POLICY_VERSION,
  contractVersion: rev.JEV_CONTRACT_VERSION, settings, calls, executedCorpusActions: false, results }, null, 2)}\n`);
process.stdout.write(`done transport=${transport} calls=${calls}\n`);
process.exit(0);
