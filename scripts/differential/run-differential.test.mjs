import { cleanupResources, isReleaseTag, npmInvocation, recordFailureEvidence } from "./run-differential.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runner = fileURLToPath(new URL("run-differential.mjs", import.meta.url));
const ownedEvidence = ["old-results.json", "new-results.json", "comparison.json", "comparison.md"];

test("builds a shell-free npm invocation on Unix and a cmd invocation on Windows", () => {
  const npmArgs = ["ci", "--ignore-scripts"];
  assert.deepEqual(npmInvocation(npmArgs, "linux", {}), { command: "npm", args: npmArgs });
  assert.deepEqual(npmInvocation(npmArgs, "darwin", {}), { command: "npm", args: npmArgs });
  assert.deepEqual(npmInvocation(npmArgs, "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", ...npmArgs],
  });
});

test("the Windows npm invocation executes npm.cmd", { skip: process.platform !== "win32" }, async () => {
  const invocation = npmInvocation(["--version"]);
  const { stdout } = await execFileAsync(invocation.command, invocation.args);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("accepts only v-prefixed SemVer release tags", () => {
  const cases = [
    ["v0.0.0", true],
    ["v2.1.0-rc.1+build.7", true],
    ["v1.2.3-alpha.0", true],
    ["v1.2.3-0A", true],
    ["1.2.3", false],
    ["v01.2.3", false],
    ["v1.02.3", false],
    ["v1.2.03", false],
    ["v1.2", false],
    ["v1.2.3.4", false],
    ["v1.2.3-01", false],
    ["v1.2.3-", false],
    ["v1.2.3-alpha..1", false],
    ["v1.2.3+", false],
    ["v1.2.3+build..7", false],
    ["v1.2.3+build_7", false],
    ["v1.2.3^{commit}", false],
  ];
  for (const [tag, expected] of cases) {
    assert.equal(isReleaseTag(tag), expected, tag);
  }
});

test("cleanup reports a checkout-parent removal failure after attempting every step", async () => {
  const calls = [];
  const removeFailure = new Error("parent removal failed");
  const failure = await cleanupResources(["old", "new"], "/tmp/checkouts", {
    runCommand: async (command, args) => { calls.push([command, ...args]); },
    removeDirectory: async () => { calls.push(["rm", "/tmp/checkouts"]); throw removeFailure; },
    repositoryRoot: "/repo",
  });

  assert.deepEqual(calls, [
    ["git", "worktree", "remove", "--force", "new"],
    ["git", "worktree", "remove", "--force", "old"],
    ["git", "worktree", "prune"],
    ["rm", "/tmp/checkouts"],
  ]);
  assert.equal(failure, removeFailure);
});

test("cleanup failure replaces a successful comparison artifact with failure evidence", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "release-differential-cleanup-"));
  const paths = {
    comparisonJson: join(sandbox, "comparison.json"),
    comparisonMarkdown: join(sandbox, "comparison.md"),
  };
  try {
    await writeFile(paths.comparisonJson, `${JSON.stringify({ passed: true, cases: [] })}\n`);
    await writeFile(paths.comparisonMarkdown, "**PASS**\n");
    await recordFailureEvidence(paths, { oldRef: "v1.0.0", newRef: "v2.0.0" }, "cleanup", new Error("parent removal failed"));

    const comparison = JSON.parse(await readFile(paths.comparisonJson, "utf8"));
    assert.deepEqual(comparison, {
      oldRef: "v1.0.0",
      newRef: "v2.0.0",
      passed: false,
      stage: "cleanup",
      error: "parent removal failed",
    });
    const markdown = await readFile(paths.comparisonMarkdown, "utf8");
    assert.match(markdown, /\*\*FAIL\*\* during \*\*cleanup\*\*/);
    assert.doesNotMatch(markdown, /\*\*PASS\*\*/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("failure preserves unrelated output content and leaves a complete diagnostic evidence set", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "release-differential-output-"));
  const unrelated = join(sandbox, "keep-me.txt");
  await writeFile(unrelated, "caller-owned\n");
  try {
    await assert.rejects(execFileAsync(process.execPath, [
      runner,
      "--old-ref", "v999999.0.0",
      "--new-ref", "v2.0.0",
      "--output-dir", sandbox,
    ]));

    assert.equal(await readFile(unrelated, "utf8"), "caller-owned\n");
    for (const filename of ownedEvidence) await access(join(sandbox, filename));
    const comparison = JSON.parse(await readFile(join(sandbox, "comparison.json"), "utf8"));
    assert.equal(comparison.passed, false);
    assert.equal(comparison.stage, "materialization");
    assert.match(await readFile(join(sandbox, "comparison.md"), "utf8"), /materialization/i);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
