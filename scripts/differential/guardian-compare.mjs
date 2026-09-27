#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGuardianCorpus } from "./guardian-corpus.mjs";
import { compareGuardianRuns, renderGuardianReport } from "./guardian-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const corpusPath = join(root, "packages/pi-permission-safe-allow/evaluation/corpus-v1.json");
const BASELINE_REF = "3ccc7d703f7895cfaf0c4a50284530dd60308414";

function options(argv) {
  const flags = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (["--plan", "--compare", "--live", "--acknowledge-model-charges"].includes(arg)) { flags.add(arg); continue; }
    if (!["--provider", "--model", "--output-dir", "--baseline-results", "--candidate-results"].includes(arg) || !argv[index + 1] || argv[index + 1].startsWith("--") || values[arg]) throw new Error(`Unknown or incomplete option: ${arg}`);
    values[arg] = argv[++index];
  }
  if (flags.has("--live")) throw new Error("Live execution is not implemented or authorized in this prepare-only harness; no inference was made.");
  if (flags.has("--plan") === flags.has("--compare") || flags.has("--acknowledge-model-charges")) throw new Error("Select exactly one offline mode, --plan or --compare.");
  if (!values["--output-dir"]?.trim()) throw new Error("An explicit --output-dir is required.");
  if (flags.has("--plan")) {
    if (!values["--provider"]?.trim() || !values["--model"]?.trim() || values["--baseline-results"] || values["--candidate-results"]) throw new Error("Plan requires only --provider, --model and --output-dir.");
    if (values["--provider"] === "vercel-ai-gateway" && values["--model"] === "typesafe-ai/jev") throw new Error("Jev evaluation needs a separate backend-specific comparison lane.");
  } else if (!values["--baseline-results"] || !values["--candidate-results"] || values["--provider"] || values["--model"]) throw new Error("Compare requires only --baseline-results, --candidate-results and --output-dir.");
  return { ...values, mode: flags.has("--plan") ? "plan" : "compare" };
}

async function main() {
  const input = options(process.argv.slice(2));
  const bytes = await readFile(corpusPath);
  const cases = validateGuardianCorpus(JSON.parse(bytes.toString("utf8")));
  const corpusId = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (input.mode === "compare") {
    const baseline = JSON.parse(await readFile(resolve(input["--baseline-results"]), "utf8"));
    const candidate = JSON.parse(await readFile(resolve(input["--candidate-results"]), "utf8"));
    if (baseline.corpusId !== corpusId || candidate.corpusId !== corpusId) throw new Error("Imported results do not match the fixed corpus digest.");
    const report = compareGuardianRuns(cases, baseline, candidate);
    report.importedResultProvenance = "not-independently-attested";
    const outputDir = resolve(input["--output-dir"]);
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(outputDir, "comparison.md"), `${renderGuardianReport(report)}\nImported results are not independently attested as live inference by this prepare-only comparator.\n`);
    if (report.status !== "pass") {
      process.stderr.write(`Guardian comparison ${report.status}; inspect ${join(outputDir, "comparison.md")}\n`);
      process.exitCode = report.status === "incomplete" ? 2 : 1;
    }
    return;
  }
  const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const baselineCommit = execFileSync("git", ["rev-parse", "--verify", `${BASELINE_REF}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
  const plan = {
    status: "not-run", reason: "Live reviewer comparison requires a separate operator-approved runner; this plan never resolves auth or performs inference.",
    baselineCommit, candidateCommit, dirty,
    corpusId,
    cases: cases.length, repeats: 3, revisions: 2, maximumInitialCalls: cases.length * 3 * 2,
    settings: { backend: "chat", provider: input["--provider"], model: input["--model"], repeats: 3, temperature: 0,
      maxAttempts: 1, includeToolResults: true, readOnlyProbes: false, investigationEnabled: false },
    outputs: { baseline: "not-produced", candidate: "not-produced", comparison: "not-produced" },
  };
  const outputDir = resolve(input["--output-dir"]);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`Offline Guardian plan written to ${join(outputDir, "plan.json")}; 0 model calls.\n`);
}

await main();
