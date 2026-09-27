import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const script = new URL("./guardian-compare.mjs", import.meta.url).pathname;

test("plan is offline, fixed-size and never writes fabricated results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guardian-plan-"));
  try {
    await exec(process.execPath, [script, "--plan", "--provider", "fixture", "--model", "same-model", "--output-dir", dir], { env: { ...process.env, OPENAI_API_KEY: "must-not-be-used" } });
    const plan = JSON.parse(await readFile(join(dir, "plan.json"), "utf8"));
    assert.equal(plan.status, "not-run");
    assert.equal(plan.maximumInitialCalls, 144);
    assert.equal(plan.cases, 24);
    assert.equal(plan.repeats, 3);
    assert.equal(plan.settings.model, "same-model");
    assert.match(plan.baselineCommit, /^[0-9a-f]{40}$/);
    assert.match(plan.candidateCommit, /^[0-9a-f]{40}$/);
    await assert.rejects(readFile(join(dir, "comparison.json")), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unimplemented live mode cannot accidentally invoke a model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guardian-live-guard-"));
  try {
    await assert.rejects(exec(process.execPath, [script, "--live", "--acknowledge-model-charges", "--provider", "fixture", "--model", "same-model", "--output-dir", dir]), /live.*not implemented|not implemented.*live/i);
    await assert.rejects(readFile(join(dir, "comparison.json")), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("imported unavailable results remain incomplete rather than a fabricated pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guardian-import-"));
  try {
    const corpusBytes = await readFile(new URL("../../packages/pi-permission-safe-allow/evaluation/corpus-v1.json", import.meta.url));
    const corpus = JSON.parse(corpusBytes.toString("utf8"));
    const corpusId = `sha256:${createHash("sha256").update(corpusBytes).digest("hex")}`;
    const settings = { backend: "chat", provider: "fixture", model: "same-model", repeats: 3, temperature: 0, maxAttempts: 1, includeToolResults: true };
    const results = corpus.map(item => ({ id: item.id, repeats: [1, 2, 3].map(index => ({ index, status: "unavailable", code: "auth", source: "live" })) }));
    const makeRun = (commit, policyVersion) => ({ commit, policyVersion, corpusId, settings, results });
    const oldPath = join(dir, "old.json"), newPath = join(dir, "new.json");
    await writeFile(oldPath, JSON.stringify(makeRun("3ccc7d703f7895cfaf0c4a50284530dd60308414", "guardian-outcomes-v1")));
    await writeFile(newPath, JSON.stringify(makeRun("19afb795624043f3f8621edbcf4fb02c8bb793f9", "guardian-outcomes-v3")));
    await assert.rejects(exec(process.execPath, [script, "--compare", "--baseline-results", oldPath, "--candidate-results", newPath, "--output-dir", dir]), /incomplete/i);
    const report = JSON.parse(await readFile(join(dir, "comparison.json"), "utf8"));
    assert.equal(report.status, "incomplete");
    assert.equal(report.candidate.summary.unavailable, 72);
    assert.match(await readFile(join(dir, "comparison.md"), "utf8"), /INCOMPLETE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
