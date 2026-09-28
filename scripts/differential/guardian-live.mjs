#!/usr/bin/env node
/**
 * Operator-authorized live comparison. Default CI never runs this file:
 * it requires PI_GUARDIAN_LIVE_COMPARISON=1 plus --live --acknowledge-model-charges.
 * Corpus actions are not executed. Credentials stay inside Pi's model registry.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { validateGuardianCorpus } from "./guardian-corpus.mjs";
import {
  LIVE_OPT_IN,
  assertLiveOptIn,
  createCallBudget,
  liveSettings,
  parseLiveArgs,
  redactPaths,
} from "./guardian-live-lib.mjs";
import { reviewCorpusCase } from "./guardian-live-review.mjs";
import { bundleRevisionSource, materializeRevision } from "./guardian-live-revision.mjs";
import { resolveHostPiCodingAgent } from "../lib/resolve-host-pi-coding-agent.mjs";

const root = resolve(import.meta.dirname, "../..");
const corpusPath = join(root, "packages/pi-permission-safe-allow/evaluation/corpus-v1.json");

function revisionBackend(model, provider) {
  return { kind: "chat", provider, id: model.id, model };
}

async function loadHost(piCmd) {
  const sdkPath = await resolveHostPiCodingAgent({
    locatePiBin: async () => piCmd,
  });
  return import(pathToFileURL(sdkPath).href);
}

function sampleKey(revision, id, index) {
  return `${revision}|${id}|${index}`;
}

async function main() {
  const argv = process.argv.slice(2);
  assertLiveOptIn(process.env, argv);
  const args = parseLiveArgs(argv);
  if (process.env.PI_CODING_AGENT_DIR?.trim()) {
    throw new Error("Unset PI_CODING_AGENT_DIR before the live runner so Pi's own agent directory supplies auth. This process does not modify that directory.");
  }
  const bytes = await readFile(corpusPath);
  const cases = validateGuardianCorpus(JSON.parse(bytes.toString("utf8")));
  const corpusId = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const settings = liveSettings(args.provider, args.model);
  const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });
  const manifestPath = join(outputDir, "manifest.json");
  let manifest = { calls: 0, samples: {} };
  if (args.resume) {
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { /* start a new manifest */ }
    if (!manifest.samples || typeof manifest.calls !== "number") throw new Error("Resume manifest is malformed.");
  }
  const budget = createCallBudget(args.maxCalls);
  while (budget.made < manifest.calls) budget.charge();

  const host = await loadHost(args.piCmd);
  const runtime = await host.ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const registry = new host.ModelRegistry(runtime);
  const model = registry.find(args.provider, args.model);
  if (!model) throw new Error(`Reviewer model ${args.provider}/${args.model} is not in the host model registry.`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth?.ok) throw new Error("Reviewer authentication is unavailable through Pi's model registry.");
  const logDir = await mkdtemp(join(tmpdir(), "guardian-live-logs-"));
  process.env.PI_CODING_AGENT_DIR = logDir;
  process.env.PI_SAFE_ALLOW_VERBOSE = "0";

  const bundleDir = join(root, "artifacts", "guardian-live-bundles");
  const baselineTree = await materializeRevision(root, args.baselineCommit);
  let baseline;
  let candidate;
  try {
    const nodeModules = join(root, "node_modules");
    baseline = await bundleRevisionSource(baselineTree.srcDir, join(bundleDir, "baseline.mjs"), nodeModules);
    candidate = await bundleRevisionSource(join(root, "packages/pi-permission-safe-allow/src"), join(bundleDir, "candidate.mjs"), nodeModules);
  } finally {
    await baselineTree.cleanup();
  }
  const revisions = [
    ["baseline", args.baselineCommit, baseline],
    ["candidate", candidateCommit, candidate],
  ];
  const backend = revisionBackend(model, args.provider);
  let consecutiveTransport = 0;
  let stopped = false;

  for (const [label, commit, revision] of revisions) {
    if (stopped) break;
    if (revision.GUARDIAN_POLICY_VERSION !== (label === "baseline" ? "guardian-outcomes-v1" : "guardian-outcomes-v3") && label === "baseline") {
      throw new Error(`Baseline policy version was ${revision.GUARDIAN_POLICY_VERSION}, expected guardian-outcomes-v1.`);
    }
    process.stdout.write(`Reviewing ${label} ${commit} policy ${revision.GUARDIAN_POLICY_VERSION}\n`);
    for (const item of cases) {
      if (stopped) break;
      for (const index of [1, 2, 3]) {
        const key = sampleKey(label, item.id, index);
        if (manifest.samples[key]) continue;
        if (consecutiveTransport >= 5) {
          manifest.samples[key] = { index, status: "unavailable", code: "transport", source: "live" };
          stopped = true;
          continue;
        }
        const runOnce = () => reviewCorpusCase({
          revision,
          item,
          index,
          settings,
          backend,
          registry,
          complete: async (chatModel, context, options) => {
            budget.charge();
            return runtime.complete(chatModel, context, { signal: options?.signal });
          },
        });
        let sample;
        try {
          sample = await runOnce();
          if (sample.status === "unavailable" && ["transport", "timeout", "model"].includes(sample.code) && budget.made < budget.cap) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            sample = await runOnce();
          }
        } catch (error) {
          if (error?.code === "hard-cap") {
            sample = { index, status: "unavailable", code: "transport", source: "live" };
            stopped = true;
          } else {
            process.stderr.write(`Sample failed closed: ${redactPaths(error?.message ?? error)}\n`);
            sample = { index, status: "unavailable", code: "transport", source: "live" };
          }
        }
        manifest.samples[key] = sample;
        manifest.calls = budget.made;
        if (sample.status === "unavailable" && ["transport", "timeout", "auth", "model"].includes(sample.code)) consecutiveTransport += 1;
        else consecutiveTransport = 0;
        if (sample.code === "auth") stopped = true;
        await writeFile(manifestPath, `${JSON.stringify({ ...manifest, commitNote: { baseline: args.baselineCommit, candidate: candidateCommit }, settings, corpusId }, null, 2)}\n`);
        process.stdout.write(`${label} ${item.id} #${index} ${sample.status === "reviewed" ? sample.final.route : sample.status + ":" + sample.code} calls=${budget.made}\n`);
        if (stopped) break;
      }
    }
  }

  const runFor = (label, commit, policyVersion) => ({
    commit,
    policyVersion,
    corpusId,
    settings,
    attestation: "operator-authorized-live-inference",
    executedCorpusActions: false,
    calls: budget.made,
    results: cases.map((item) => ({
      id: item.id,
      repeats: [1, 2, 3].map((index) => manifest.samples[sampleKey(label, item.id, index)] ?? { index, status: "unavailable", code: "transport", source: "live" }),
    })),
  });
  await writeFile(join(outputDir, "baseline.json"), `${JSON.stringify(runFor("baseline", args.baselineCommit, baseline.GUARDIAN_POLICY_VERSION), null, 2)}\n`);
  await writeFile(join(outputDir, "candidate.json"), `${JSON.stringify(runFor("candidate", candidateCommit, candidate.GUARDIAN_POLICY_VERSION), null, 2)}\n`);
  process.stdout.write(`Live comparison raw results written; reviewer calls=${budget.made}. Corpus actions executed=0.\n`);
  await rm(logDir, { recursive: true, force: true });
  process.exit(0);
}

try {
  await main();
} catch (error) {
  if (String(error?.message ?? "").includes(LIVE_OPT_IN) || String(error?.message ?? "").includes("opt-in")) {
    process.stderr.write(`${redactPaths(error.message)}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${redactPaths(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  }
}
