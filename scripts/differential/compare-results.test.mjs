import assert from "node:assert/strict";
import test from "node:test";

import { compareResults, renderMarkdown } from "./compare-results.mjs";

const OLD_COMMIT = "91bb4ba5f6882b5df20e537e6ebb487ad738e566";
const NEW_COMMIT = "b1819950027665d87e690e9a82560d5213967799";
const eventCounts = () => ({
  extension_loaded: 1,
  permissions_ready: 1,
  session_start: 1,
  "review.routed": 0,
  "review.decision": 0,
  "review.failure": 0,
  "probe.completed": 0,
});

const allow = (id) => ({
  id,
  toolCallResult: {},
  decisions: [{ surface: id === "bash-pwd" ? "bash" : "read", value: id === "bash-pwd" ? "pwd" : "<CWD>/file.txt", result: "allow", resolution: "policy_allow", origin: "global", agentName: null, matchedPattern: id === "bash-pwd" ? "pwd" : "*" }],
});

test("accepts compatibility invariants and the independently specified secret hard-deny improvement", () => {
  const oldResults = { ref: "v1.0.0", commit: OLD_COMMIT, cases: [allow("bundle-read"), allow("bash-pwd"), { ...allow("protected-secret"), decisions: [{ ...allow("bundle-read").decisions[0], value: "<CWD>/.env.production" }] }], safeAllowJsonlCounts: eventCounts(), modelAttempts: 0 };
  const newResults = { ref: "v2.0.0", cases: [
    { ...allow("bundle-read"), decisions: [{ ...allow("bundle-read").decisions[0], routingSource: "local_allow" }] },
    { ...allow("bash-pwd"), decisions: [{ ...allow("bash-pwd").decisions[0], routingSource: "local_allow" }] },
    { id: "protected-secret", toolCallResult: { block: true, reason: "HARD_DENY_SECRET_PATH: access to a high-sensitivity secret path is blocked by the built-in safety baseline" }, decisions: [{ surface: "read", value: "<CWD>/.env.production", result: "deny", resolution: "hard_deny", routingSource: "hard_deny", origin: "builtin", agentName: null, matchedPattern: null, denyCode: "HARD_DENY_SECRET_PATH" }] },
  ], commit: NEW_COMMIT, safeAllowJsonlCounts: eventCounts(), modelAttempts: 0 };

  const comparison = compareResults(oldResults, newResults);
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.summary, { passed: 3, failed: 0, total: 3 });
  assert.equal(comparison.cases.find(({ id }) => id === "protected-secret").classification, "expected-v2-improvement");
  assert.equal(comparison.oldCommit, OLD_COMMIT);
  assert.equal(comparison.newCommit, NEW_COMMIT);
  assert.deepEqual(comparison.safeAllowJsonlCounts.old, eventCounts());
});

test("fails when an invariant changes or the expected improvement is absent", () => {
  const oldResults = { ref: "v1.0.0", commit: OLD_COMMIT, cases: [allow("bundle-read"), allow("bash-pwd"), allow("protected-secret")], safeAllowJsonlCounts: {}, modelAttempts: 0 };
  const routed = (observation) => ({ ...observation, decisions: observation.decisions.map((decision) => ({ ...decision, routingSource: "local_allow" })) });
  const newResults = { ref: "v2.0.0", commit: NEW_COMMIT, cases: [{ ...routed(allow("bundle-read")), toolCallResult: { block: true } }, routed(allow("bash-pwd")), routed(allow("protected-secret"))], safeAllowJsonlCounts: {}, modelAttempts: 0 };
  const comparison = compareResults(oldResults, newResults);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.summary.failed, 2);
});

test("independently requires zero review, model, and probe activity for the deterministic corpus", () => {
  const oldResults = { ref: "v1.0.0", commit: OLD_COMMIT, cases: [allow("bundle-read"), allow("bash-pwd"), { ...allow("protected-secret"), decisions: [{ ...allow("bundle-read").decisions[0], value: "<CWD>/.env.production" }] }], safeAllowJsonlCounts: eventCounts(), modelAttempts: 0 };
  const newResults = { ref: "v2.0.0", commit: NEW_COMMIT, cases: [
    { ...allow("bundle-read"), decisions: [{ ...allow("bundle-read").decisions[0], routingSource: "local_allow" }] },
    { ...allow("bash-pwd"), decisions: [{ ...allow("bash-pwd").decisions[0], routingSource: "local_allow" }] },
    { id: "protected-secret", toolCallResult: { block: true, reason: "HARD_DENY_SECRET_PATH: access to a high-sensitivity secret path is blocked by the built-in safety baseline" }, decisions: [{ surface: "read", value: "<CWD>/.env.production", result: "deny", resolution: "hard_deny", routingSource: "hard_deny", origin: "builtin", agentName: null, matchedPattern: null, denyCode: "HARD_DENY_SECRET_PATH" }] },
  ], safeAllowJsonlCounts: eventCounts(), modelAttempts: 0 };

  for (const event of ["review.routed", "review.decision", "review.failure", "probe.completed"]) {
    const comparison = compareResults(oldResults, {
      ...newResults,
      safeAllowJsonlCounts: { ...newResults.safeAllowJsonlCounts, [event]: 1 },
    });
    assert.equal(comparison.passed, false, event);
    assert.equal(comparison.safeAllowJsonlCounts.passed, false, event);
  }
  const modelComparison = compareResults(oldResults, { ...newResults, modelAttempts: 1 });
  assert.equal(modelComparison.passed, false);
  assert.deepEqual(modelComparison.modelAttempts, { passed: false, old: 0, new: 1 });
});

test("renders the exact immutable commits compared", () => {
  const markdown = renderMarkdown({
    oldRef: "v1.0.0", newRef: "v2.0.0", oldCommit: OLD_COMMIT, newCommit: NEW_COMMIT, passed: true,
    summary: { passed: 0, failed: 0, total: 0 }, cases: [], unexpectedCaseIds: [],
    safeAllowJsonlCounts: { passed: true, old: eventCounts(), new: eventCounts() },
    modelAttempts: { passed: true, old: 0, new: 0 },
  });

  assert.ok(markdown.includes(`v1.0.0 at \`${OLD_COMMIT}\``));
  assert.ok(markdown.includes(`v2.0.0 at \`${NEW_COMMIT}\``));
  assert.match(markdown, /Model attempts.*0.*0/);
});
