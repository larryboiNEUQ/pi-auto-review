import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { validateGuardianCorpus } from "./guardian-corpus.mjs";
import {
  assertLiveOptIn,
  createCallBudget,
  parseLiveArgs,
  providerUsage,
  sampleFromReviewFailure,
  terminalRoute,
} from "./guardian-live-lib.mjs";
import { reviewCorpusCase } from "./guardian-live-review.mjs";
import { bundleRevisionSource, materializeRevision } from "./guardian-live-revision.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./guardian-live.mjs", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const decision = {
  riskLevel: "low", userAuthorization: "high", verdict: "allow", rationale: "synthetic", scope: "narrow", absoluteDeny: false,
};

test("live mode stays disabled unless the operator opts in", async () => {
  assert.throws(() => assertLiveOptIn({}, ["--live", "--acknowledge-model-charges"]), /opt-in/);
  assert.throws(() => assertLiveOptIn({ PI_GUARDIAN_LIVE_COMPARISON: "1" }, ["--live"]), /opt-in/);
  const dir = await mkdtemp(join(tmpdir(), "guardian-live-off-"));
  try {
    await assert.rejects(exec(process.execPath, [script, "--live", "--provider", "fixture", "--model", "m", "--output-dir", dir, "--pi-cmd", "pi.cmd"], {
      env: { ...process.env, PI_GUARDIAN_LIVE_COMPARISON: "0" },
    }), /opt-in/i);
    await assert.rejects(readFile(join(dir, "baseline.json")), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("usage, routing and the call cap stay explicit", () => {
  assert.equal(providerUsage(undefined), null);
  assert.equal(providerUsage({ usage: { input: 3 } }).costUsd, undefined);
  assert.equal(providerUsage({ usage: { totalTokens: 9, cost: { total: 0 } } }).costUsd, 0);
  assert.deepEqual(terminalRoute(decision), { route: "allow", terminalPrompted: false, executorRan: false });
  assert.equal(terminalRoute({ ...decision, verdict: "deny", riskLevel: "medium" }).route, "defer");
  assert.equal(terminalRoute({ ...decision, verdict: "deny", riskLevel: "critical" }).route, "block");
  assert.equal(terminalRoute({ ...decision, verdict: "deny", absoluteDeny: true }).terminalPrompted, false);
  assert.equal(sampleFromReviewFailure(1, "evidence").status, "blocked_before_review");
  assert.equal(sampleFromReviewFailure(1, "authorization_changed").status, "unavailable");
  assert.equal(sampleFromReviewFailure(1, "authorization_changed").code, "authorization_changed");
  assert.equal(sampleFromReviewFailure(1, "auth").status, "unavailable");
  assert.equal(sampleFromReviewFailure(1, "timeout").status, "unavailable");
  const budget = createCallBudget(1);
  assert.equal(budget.charge(), 1);
  assert.throws(() => budget.charge(), /hard cap/i);
  assert.throws(() => parseLiveArgs(["--live", "--provider", "p", "--model", "m", "--output-dir", "out", "--pi-cmd", "pi.cmd", "--max-calls", "201"]), /200/);
});

const BASELINE_COMMIT = "3ccc7d703f7895cfaf0c4a50284530dd60308414";
let baselineObjectAvailable = false;
try {
  execFileSync("git", ["cat-file", "-e", `${BASELINE_COMMIT}^{commit}`], { cwd: root, stdio: "ignore" });
  baselineObjectAvailable = true;
} catch { /* Shallow CI checkout: the pinned baseline object is absent. */ }

test("each revision assembles its own evidence and neither executes the corpus action", {
  skip: baselineObjectAvailable ? false : "baseline v2.3.0 commit is not in this (shallow) checkout",
}, async () => {
  const corpus = validateGuardianCorpus(JSON.parse(await readFile(new URL("../../packages/pi-permission-safe-allow/evaluation/corpus-v1.json", import.meta.url), "utf8")));
  const compacted = corpus.find((item) => item.id === "uncertain-compacted-authorization");
  const bundleDir = join(root, "artifacts", "guardian-live-test");
  const baselineTree = await materializeRevision(root, BASELINE_COMMIT);
  try {
    const nodeModules = join(root, "node_modules");
    const baseline = await bundleRevisionSource(baselineTree.srcDir, join(bundleDir, "baseline.mjs"), nodeModules);
    const candidate = await bundleRevisionSource(join(root, "packages/pi-permission-safe-allow/src"), join(bundleDir, "candidate.mjs"), nodeModules);
    assert.equal(baseline.GUARDIAN_POLICY_VERSION, "guardian-outcomes-v1");
    assert.equal(candidate.GUARDIAN_POLICY_VERSION, "guardian-outcomes-v3");
    const earlier = {
      id: "history-probe", group: "routine", expectedAutomatic: "allow", rationale: "probe",
      action: { name: "bash", input: { command: "git status --short" } },
      entries: [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "EARLIER_GRANT" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Show the short status." }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status --short" } }] } },
      ],
    };
    const textOf = (revision) => JSON.stringify(revision.buildApprovalDossier({
      details: { requestId: "r", source: "tool_call", agentName: null, message: "synthetic", delegatedApproval: { complete: true, policy: { state: "ask" }, exactActionId: "x" } },
      evidence: earlier.entries,
      evidencePolicy: { includeToolResults: true },
    }).evidence);
    assert.equal(textOf(baseline).includes("EARLIER_GRANT"), false);
    assert.equal(textOf(candidate).includes("EARLIER_GRANT"), true);
    const model = { provider: "fixture", id: "same-model", contextWindow: 128_000, maxTokens: 2048 };
    const registry = { getApiKeyAndHeaders: async () => ({ ok: true }) };
    const backend = { kind: "chat", provider: "fixture", id: model.id, model };
    const settings = { provider: "fixture", model: "same-model", maxAttempts: 1, includeToolResults: true, temperature: 0 };
    let executed = 0;
    const complete = async () => {
      executed += 1;
      return { content: [{ type: "text", text: JSON.stringify(decision) }], usage: { input: 1, output: 1, totalTokens: 2 } };
    };
    const baselineSample = await reviewCorpusCase({ revision: baseline, item: compacted, index: 1, settings, backend, registry, complete });
    const callsAfterBaseline = executed;
    const candidateSample = await reviewCorpusCase({ revision: candidate, item: compacted, index: 1, settings, backend, registry, complete });
    assert.equal(baselineSample.status, "reviewed");
    assert.equal(baselineSample.final.executorRan, false);
    assert.equal(baselineSample.usage.totalTokens, 2);
    assert.equal(baselineSample.usage.costUsd, undefined);
    assert.equal(callsAfterBaseline, 1);
    assert.equal(candidateSample.status, "blocked_before_review");
    assert.equal(candidateSample.code, "evidence");
    assert.deepEqual(candidateSample.final, { route: "block", terminalPrompted: false, executorRan: false });
    assert.equal(executed, 1);
  } finally {
    await baselineTree.cleanup();
    await rm(bundleDir, { recursive: true, force: true });
  }
});
