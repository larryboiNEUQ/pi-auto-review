#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "../..");
const EVIDENCE_FILENAMES = ["old-results.json", "new-results.json", "comparison.json", "comparison.md"];

export function npmInvocation(args, platform = process.platform, environment = process.env) {
  if (platform === "win32") {
    return {
      command: environment.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args],
    };
  }
  return { command: "npm", args };
}

export function isReleaseTag(value) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return false;
  const prerelease = match[4];
  return prerelease === undefined || prerelease.split(".").every((identifier) => !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0"));
}

function parseArgs(argv) {
  const options = { oldRef: "v1.0.0", newRef: "v2.0.0", outputDir: resolve("artifacts/release-differential") };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--old-ref") options.oldRef = argv[++index];
    else if (value === "--new-ref") options.newRef = argv[++index];
    else if (value === "--output-dir") options.outputDir = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const [name, ref] of [["old", options.oldRef], ["new", options.newRef]]) {
    if (!isReleaseTag(ref)) throw new Error(`${name} ref must be a v-prefixed SemVer release tag (received ${ref})`);
  }
  return options;
}

async function run(command, args, options = {}) {
  try { return await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024, ...options }); }
  catch (error) { process.stderr.write(error.stderr ?? ""); throw error; }
}

async function resolveTag(ref) {
  const { stdout: revision } = await run("git", ["rev-parse", "--verify", `refs/tags/${ref}^{commit}`], { cwd: repositoryRoot });
  const commit = revision.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error(`Resolved ${ref} to malformed commit SHA: ${JSON.stringify(commit)}`);
  }
  return commit;
}

async function initializeEvidence(options, paths) {
  await mkdir(options.outputDir, { recursive: true });
  for (const filename of EVIDENCE_FILENAMES) await rm(join(options.outputDir, filename), { force: true });
  const placeholder = (ref) => `${JSON.stringify({ ref, commit: null, status: "not-produced" }, null, 2)}\n`;
  await writeFile(paths.oldResults, placeholder(options.oldRef));
  await writeFile(paths.newResults, placeholder(options.newRef));
  await writeFile(paths.comparisonJson, `${JSON.stringify({ passed: false, stage: "initialization", error: "Run did not complete" }, null, 2)}\n`);
  await writeFile(paths.comparisonMarkdown, "# Release differential\n\n**FAIL** — run did not complete.\n");
}

async function writeFailureEvidence(paths, options, stage, error) {
  const diagnostic = {
    oldRef: options.oldRef,
    newRef: options.newRef,
    passed: false,
    stage,
    error: error instanceof Error ? error.message : String(error),
  };
  await writeFile(paths.comparisonJson, `${JSON.stringify(diagnostic, null, 2)}\n`);
  await writeFile(paths.comparisonMarkdown, `# Release differential: ${options.oldRef} → ${options.newRef}\n\n**FAIL** during **${stage}**.\n\n\`\`\`text\n${diagnostic.error}\n\`\`\`\n`);
}

async function hasCompletedComparison(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return typeof value.passed === "boolean" && Array.isArray(value.cases);
  } catch { return false; }
}

export async function recordFailureEvidence(paths, options, stage, error) {
  if (stage !== "comparison" || !(await hasCompletedComparison(paths.comparisonJson))) {
    await writeFailureEvidence(paths, options, stage, error);
  }
}

export async function cleanupResources(addedWorktrees, checkoutParent, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? run;
  const removeDirectory = dependencies.removeDirectory ?? rm;
  const root = dependencies.repositoryRoot ?? repositoryRoot;
  let failure;

  for (const checkout of [...addedWorktrees].reverse()) {
    try { await runCommand("git", ["worktree", "remove", "--force", checkout], { cwd: root }); }
    catch (error) { failure ??= error; }
  }
  try { await runCommand("git", ["worktree", "prune"], { cwd: root }); }
  catch (error) { failure ??= error; }
  try { await removeDirectory(checkoutParent, { recursive: true, force: true }); }
  catch (error) { failure ??= error; }
  return failure;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = {
    oldResults: join(options.outputDir, "old-results.json"),
    newResults: join(options.outputDir, "new-results.json"),
    comparisonJson: join(options.outputDir, "comparison.json"),
    comparisonMarkdown: join(options.outputDir, "comparison.md"),
  };
  await initializeEvidence(options, paths);

  const checkoutParent = await mkdtemp(join(tmpdir(), "pi-release-differential-checkouts-"));
  const oldCheckout = join(checkoutParent, "old");
  const newCheckout = join(checkoutParent, "new");
  const addedWorktrees = [];
  let stage = "materialization";
  let failure;
  try {
    const oldCommit = await resolveTag(options.oldRef);
    const newCommit = await resolveTag(options.newRef);
    for (const [checkout, commit] of [[oldCheckout, oldCommit], [newCheckout, newCommit]]) {
      await run("git", ["worktree", "add", "--detach", checkout, commit], { cwd: repositoryRoot });
      addedWorktrees.push(checkout);
    }

    stage = "install";
    const npm = npmInvocation(["ci", "--ignore-scripts"]);
    await run(npm.command, npm.args, { cwd: oldCheckout });
    await run(npm.command, npm.args, { cwd: newCheckout });

    stage = "version-run";
    await run(process.execPath, [join(scriptDir, "run-version.mjs"), join(oldCheckout, "index.js"), options.oldRef, oldCommit, paths.oldResults]);
    await run(process.execPath, [join(scriptDir, "run-version.mjs"), join(newCheckout, "index.js"), options.newRef, newCommit, paths.newResults]);

    stage = "comparison";
    await run(process.execPath, [join(scriptDir, "compare-results.mjs"), paths.oldResults, paths.newResults, paths.comparisonJson, paths.comparisonMarkdown]);
  } catch (error) {
    failure = error;
  } finally {
    const cleanupFailure = await cleanupResources(addedWorktrees, checkoutParent);
    if (cleanupFailure && !failure) {
      failure = cleanupFailure;
      stage = "cleanup";
    }
  }

  if (failure) {
    await recordFailureEvidence(paths, options, stage, failure);
    process.stderr.write(`Release differential failed; inspect ${paths.comparisonMarkdown}\n`);
    throw failure;
  }
  for (const path of Object.values(paths)) await access(path);
  process.stdout.write(`Release differential passed: ${paths.comparisonMarkdown}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
