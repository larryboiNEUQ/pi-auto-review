#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

/** Single composition entry shown in Pi UI; factories stay in-repo workspaces.
 * Root `./index.ts` matches other Pi packages so startup labels strip the
 * filename and show the package name without a `.ts` suffix. */
const EXPECTED_EXTENSIONS = ["index.ts"];
const EXPECTED_WORKSPACES = [
  "packages/pi-permission-system",
  "packages/pi-permission-safe-allow",
];
const EXPECTED_FACTORY_SOURCES = [
  "packages/pi-permission-system/src/index.ts",
  "packages/pi-permission-safe-allow/src/index.ts",
];

function parseArgs(argv) {
  const options = {
    checkout: undefined,
    source: undefined,
    expectPlatform: undefined,
    keep: false,
    piBin: process.platform === "win32" ? "pi.cmd" : "pi",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--checkout") options.checkout = argv[++index];
    else if (arg === "--source") options.source = argv[++index];
    else if (arg === "--pi-bin") options.piBin = argv[++index];
    else if (arg === "--expect-platform") options.expectPlatform = argv[++index];
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.checkout && options.source) {
    throw new Error("Use either --checkout for a local contract check or --source for a real Git smoke.");
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function isWithin(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function findPackageRoot(start) {
  let current = dirname(start);
  while (true) {
    if (existsSync(join(current, "package.json"))) return realpath(current);
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find package root for ${start}`);
    current = parent;
  }
}

async function resolveDependencyFrom(packageDir, dependency) {
  const manifestPath = join(packageDir, "package.json");
  const requireFromPackage = createRequire(pathToFileURL(manifestPath));
  try {
    return realpath(requireFromPackage.resolve(dependency));
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let current = packageDir;
    while (true) {
      const candidate = join(current, "node_modules", ...dependency.split("/"), "package.json");
      if (existsSync(candidate)) return realpath(dirname(candidate));
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function verifyManifestContract(checkout) {
  const rootManifest = await readJson(join(checkout, "package.json"));
  assert.equal(rootManifest.private, true, "the Git bundle root must be private");
  assert.deepEqual(rootManifest.workspaces, EXPECTED_WORKSPACES, "workspace membership changed");
  assert.deepEqual(
    rootManifest.pi?.extensions,
    EXPECTED_EXTENSIONS.map((entry) => `./${entry}`),
    "Pi extension discovery must expose exactly one composition entry",
  );
  for (const factory of EXPECTED_FACTORY_SOURCES) {
    assert.ok(existsSync(join(checkout, factory)), `missing in-repo factory: ${factory}`);
  }

  const systemManifest = await readJson(join(checkout, "packages/pi-permission-system/package.json"));
  const safeManifest = await readJson(join(checkout, "packages/pi-permission-safe-allow/package.json"));
  assert.equal(
    safeManifest.dependencies?.[systemManifest.name],
    systemManifest.version,
    "safe-allow must depend on the exact bundled permission-system version",
  );
  assert.ok(existsSync(join(checkout, "package-lock.json")), "the Git bundle must commit a lockfile");
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const usesWindowsCommandShim = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
    if (usesWindowsCommandShim) {
      assert.ok(
        args.every((arg) => /^[A-Za-z0-9_./:@\\-]+$/.test(arg)),
        "refusing to pass unsafe characters to a Windows command shim",
      );
    }
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
      shell: usesWindowsCommandShim,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout.trim());
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "failed to allocate a fixture port");
  const { port } = address;
  await new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return port;
}

async function waitForGitRemote(source) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await runCapture("git", ["ls-remote", source, "HEAD"]);
      return;
    } catch {
      // The daemon may still be binding its port, especially on Windows.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`git daemon did not become ready for ${source}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  child.kill();
  await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
}

async function findInstalledCheckout(agentDir) {
  const gitRoot = join(agentDir, "git");
  const pending = [gitRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      const manifestPath = join(path, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = await readJson(manifestPath);
        if (manifest.name === "pi-auto-review") return realpath(path);
      }
      pending.push(path);
    }
  }
  throw new Error(`Could not find the installed Git checkout below ${gitRoot}`);
}

async function verifyRuntime(checkout, agentDir, source, smokeCwd) {
  await verifyManifestContract(checkout);

  const settings = await readJson(join(agentDir, "settings.json"));
  assert.deepEqual(settings.packages, [source], "isolated settings must record exactly one Git source");

  const sdkPath = join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  assert.ok(existsSync(sdkPath), "Pi runtime dependencies were not installed in the Git checkout");
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(sdkPath).href);
  const settingsManager = SettingsManager.create(smokeCwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd: smokeCwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);

  const loadedPaths = await Promise.all(
    loaded.extensions.map((extension) => realpath(resolve(extension.resolvedPath))),
  );
  const expectedPaths = await Promise.all(
    EXPECTED_EXTENSIONS.map((entry) => realpath(resolve(checkout, entry))),
  );
  assert.deepEqual(
    loadedPaths,
    expectedPaths,
    "Pi must load exactly the single pi-auto-review composition entry",
  );

  const packageDirs = [
    join(checkout, "packages/pi-permission-system"),
    join(checkout, "packages/pi-permission-safe-allow"),
  ];
  for (const packageDir of packageDirs) {
    const manifestPath = join(packageDir, "package.json");
    const manifest = await readJson(manifestPath);
    const runtimeDependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    };
    for (const dependency of Object.keys(runtimeDependencies)) {
      const resolvedEntry = await resolveDependencyFrom(packageDir, dependency);
      assert.ok(
        isWithin(resolvedEntry, checkout),
        `${manifest.name} resolved ${dependency} outside the installed Git checkout: ${resolvedEntry}`,
      );
    }
  }

  const safeRequire = createRequire(
    pathToFileURL(join(checkout, "packages/pi-permission-safe-allow/package.json")),
  );
  const systemRoot = await findPackageRoot(safeRequire.resolve("@gotgenes/pi-permission-system"));
  assert.equal(
    systemRoot,
    await realpath(join(checkout, "packages/pi-permission-system")),
    "safe-allow resolved a permission-system copy other than the bundled workspace fork",
  );
}

async function runGitSmoke(source, options, afterInstall) {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-git-bundle-smoke-")));
  const smokeCwd = await realpath(await mkdtemp(join(tmpdir(), "pi-git-bundle-cwd-")));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  try {
    await run(options.piBin, ["install", source], { env, cwd: smokeCwd });
    const checkout = await findInstalledCheckout(agentDir);
    await verifyRuntime(checkout, agentDir, source, smokeCwd);
    const headBefore = await runCapture("git", ["rev-parse", "HEAD"], { cwd: checkout, env });
    await afterInstall?.({ agentDir, checkout, env, smokeCwd });
    await run(options.piBin, ["update", source], { env, cwd: smokeCwd });
    await verifyRuntime(checkout, agentDir, source, smokeCwd);
    const headAfter = await runCapture("git", ["rev-parse", "HEAD"], { cwd: checkout, env });
    return { agentDir, headAfter, headBefore };
  } finally {
    if (!options.keep) {
      await rm(agentDir, { recursive: true, force: true });
      await rm(smokeCwd, { recursive: true, force: true });
    }
  }
}

async function runUpdateFixture(sourceCheckout, options) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-git-bundle-remote-"));
  const worktree = join(fixtureRoot, "worktree");
  const remoteRoot = join(fixtureRoot, "remote");
  const bareRepo = join(remoteRoot, "owner", "repo.git");
  let daemon;
  try {
    await cp(sourceCheckout, worktree, {
      recursive: true,
      filter: (source) => {
        const rel = relative(sourceCheckout, source);
        if (!rel) return true;
        const segments = rel.split(sep);
        return !segments.some((segment) => [".git", ".scratch", "node_modules"].includes(segment));
      },
    });
    await run("git", ["init", "--initial-branch=main"], { cwd: worktree, stdio: "ignore" });
    await run("git", ["config", "user.email", "pi-bundle-smoke@example.invalid"], { cwd: worktree });
    await run("git", ["config", "user.name", "Pi bundle smoke"], { cwd: worktree });
    await run("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
    await run("git", ["commit", "-m", "fixture A"], { cwd: worktree, stdio: "ignore" });
    await mkdir(dirname(bareRepo), { recursive: true });
    await run("git", ["clone", "--bare", worktree, bareRepo], { stdio: "ignore" });

    const port = await getFreePort();
    daemon = spawn(
      "git",
      ["daemon", "--reuseaddr", "--export-all", `--base-path=${remoteRoot}`, "--listen=127.0.0.1", `--port=${port}`, remoteRoot],
      { stdio: "inherit" },
    );
    const source = `git:git://127.0.0.1:${port}/owner/repo.git`;
    await waitForGitRemote(source.slice("git:".length));
    const receipt = await runGitSmoke(source, options, async ({ agentDir, checkout }) => {
      await writeFile(join(worktree, ".pi-git-bundle-update-marker"), "fixture B\n");
      await run("git", ["add", ".pi-git-bundle-update-marker"], { cwd: worktree, stdio: "ignore" });
      await run("git", ["commit", "-m", "fixture B"], { cwd: worktree, stdio: "ignore" });
      await run("git", ["push", bareRepo, "HEAD:main"], { cwd: worktree, stdio: "ignore" });
      assert.ok(isWithin(checkout, agentDir), "refusing to clean dependencies outside the isolated agent directory");
      await rm(join(checkout, "node_modules"), { recursive: true, force: true });
    });
    assert.notEqual(receipt.headBefore, receipt.headAfter, "fixture update did not advance Git HEAD");
    console.log(`Git changed-HEAD install/update smoke passed on ${process.platform}/${process.arch}`);
  } finally {
    await stopProcess(daemon);
    if (!options.keep) await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.checkout) {
    const checkout = await realpath(resolve(options.checkout));
    await verifyManifestContract(checkout);
    console.log(`Bundle contract verified: ${checkout}`);
    return;
  }

  if (options.expectPlatform) {
    assert.equal(
      `${process.platform}/${process.arch}`,
      options.expectPlatform,
      "smoke ran on an unexpected platform/architecture",
    );
  }

  if (options.source) {
    const receipt = await runGitSmoke(options.source, options);
    console.log(`GitHub install/update smoke passed on ${process.platform}/${process.arch}`);
    if (options.keep) console.log(`Preserved isolated agent directory: ${receipt.agentDir}`);
    return;
  }
  await runUpdateFixture(await realpath(resolve(".")), options);
}

await main();
