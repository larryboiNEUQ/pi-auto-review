#!/usr/bin/env node

import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED = {
  "bundle-read": {
    classification: "compatibility-invariant",
    oldResult: {},
    oldDecision: { surface: "read", value: "<CWD>/file.txt", result: "allow", resolution: "policy_allow", origin: "global", agentName: null, matchedPattern: "*" },
    newResult: {},
    newDecision: { surface: "read", value: "<CWD>/file.txt", result: "allow", resolution: "policy_allow", routingSource: "local_allow", origin: "global", agentName: null, matchedPattern: "*" }
  },
  "bash-pwd": {
    classification: "compatibility-invariant",
    oldResult: {},
    oldDecision: { surface: "bash", value: "pwd", result: "allow", resolution: "policy_allow", origin: "global", agentName: null, matchedPattern: "pwd" },
    newResult: {},
    newDecision: { surface: "bash", value: "pwd", result: "allow", resolution: "policy_allow", routingSource: "local_allow", origin: "global", agentName: null, matchedPattern: "pwd" }
  },
  "protected-secret": {
    classification: "expected-v2-improvement",
    oldResult: {},
    oldDecision: { surface: "read", value: "<CWD>/.env.production", result: "allow", resolution: "policy_allow", origin: "global", agentName: null, matchedPattern: "*" },
    newResult: { block: true, reason: "HARD_DENY_SECRET_PATH: access to a high-sensitivity secret path is blocked by the built-in safety baseline" },
    newDecision: { surface: "read", value: "<CWD>/.env.production", result: "deny", resolution: "hard_deny", routingSource: "hard_deny", origin: "builtin", agentName: null, matchedPattern: null, denyCode: "HARD_DENY_SECRET_PATH" }
  },
};
const EXPECTED_SAFE_ALLOW_JSONL_COUNTS = {
  extension_loaded: 1,
  permissions_ready: 1,
  session_start: 1,
  "review.routed": 0,
  "review.decision": 0,
  "review.failure": 0,
  "probe.completed": 0,
};


function matches(observation, result, decision) {
  return isDeepStrictEqual(observation?.toolCallResult, result)
    && observation?.decisions?.length === 1
    && isDeepStrictEqual(observation.decisions[0], decision);
}

export function compareResults(oldResults, newResults) {
  const oldById = new Map(oldResults.cases.map((entry) => [entry.id, entry]));
  const newById = new Map(newResults.cases.map((entry) => [entry.id, entry]));
  const cases = Object.entries(EXPECTED).map(([id, expected]) => {
    const oldObservation = oldById.get(id);
    const newObservation = newById.get(id);
    const passed = matches(oldObservation, expected.oldResult, expected.oldDecision)
      && matches(newObservation, expected.newResult, expected.newDecision);
    return { id, classification: expected.classification, passed, old: oldObservation ?? null, new: newObservation ?? null };
  });
  const expectedIds = new Set(Object.keys(EXPECTED));
  const unexpectedIds = [...new Set([...oldById.keys(), ...newById.keys()])].filter((id) => !expectedIds.has(id));
  const logCountsMatch = isDeepStrictEqual(oldResults.safeAllowJsonlCounts, EXPECTED_SAFE_ALLOW_JSONL_COUNTS)
    && isDeepStrictEqual(newResults.safeAllowJsonlCounts, EXPECTED_SAFE_ALLOW_JSONL_COUNTS);
  const modelAttemptsMatch = oldResults.modelAttempts === 0 && newResults.modelAttempts === 0;
  const failed = cases.filter(({ passed }) => !passed).length;
  return {
    oldRef: oldResults.ref,
    oldCommit: oldResults.commit,
    newRef: newResults.ref,
    newCommit: newResults.commit,
    passed: failed === 0 && unexpectedIds.length === 0 && logCountsMatch && modelAttemptsMatch,
    summary: { passed: cases.length - failed, failed, total: cases.length },
    safeAllowJsonlCounts: { passed: logCountsMatch, old: oldResults.safeAllowJsonlCounts, new: newResults.safeAllowJsonlCounts },
    modelAttempts: { passed: modelAttemptsMatch, old: oldResults.modelAttempts, new: newResults.modelAttempts },
    unexpectedCaseIds: unexpectedIds,
    cases,
  };
}

export function renderMarkdown(comparison) {
  const status = comparison.passed ? "PASS" : "FAIL";
  const rows = comparison.cases.map((entry) => `| \`${entry.id}\` | ${entry.classification} | ${entry.passed ? "PASS" : "FAIL"} |`).join("\n");
  return `# Release differential: ${comparison.oldRef} → ${comparison.newRef}\n\n**Compared commits**\n\n- Old: ${comparison.oldRef} at \`${comparison.oldCommit}\`\n- New: ${comparison.newRef} at \`${comparison.newCommit}\`\n\n**${status}** — ${comparison.summary.passed}/${comparison.summary.total} behavioral cases passed.\n\n| Case | Classification | Result |\n|---|---|---|\n${rows}\n\n## Safe-allow public JSONL observations\n\n- Event-count result: **${comparison.safeAllowJsonlCounts.passed ? "PASS" : "FAIL"}**\n- Old counts: \`${JSON.stringify(comparison.safeAllowJsonlCounts.old)}\`\n- New counts: \`${JSON.stringify(comparison.safeAllowJsonlCounts.new)}\`\n- Model attempts: **${comparison.modelAttempts.passed ? "PASS" : "FAIL"}** — old \`${comparison.modelAttempts.old}\`, new \`${comparison.modelAttempts.new}\`\n${comparison.unexpectedCaseIds.length ? `\nUnexpected case IDs: ${comparison.unexpectedCaseIds.join(", ")}\n` : ""}`;
}

async function main() {
  const [oldPath, newPath, jsonPath, markdownPath] = process.argv.slice(2);
  if (!oldPath || !newPath || !jsonPath || !markdownPath) throw new Error("Usage: compare-results.mjs OLD NEW COMPARISON_JSON COMPARISON_MD");
  const comparison = compareResults(JSON.parse(await readFile(oldPath, "utf8")), JSON.parse(await readFile(newPath, "utf8")));
  await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(markdownPath, `${renderMarkdown(comparison)}\n`);
  if (!comparison.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
