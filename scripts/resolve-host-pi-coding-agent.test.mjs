import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveHostPiCodingAgent } from "./lib/resolve-host-pi-coding-agent.mjs";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

async function makePackage(root, name = PACKAGE_NAME) {
  const sdkPath = join(root, "dist", "index.js");
  await mkdir(dirname(sdkPath), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name }));
  await writeFile(sdkPath, "export {};\n");
  return realpath(sdkPath);
}

test("resolves a Windows npm global package beside the pi.cmd shim", async (t) => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-host-sdk-win-shim-"));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  const shimPath = join(prefix, "pi.cmd");
  await writeFile(shimPath, "@echo off\r\n");
  const sdkPath = await makePackage(join(prefix, "node_modules", ...PACKAGE_NAME.split("/")));

  const resolved = await resolveHostPiCodingAgent({
    platform: "win32",
    locatePiBin: async (name) => {
      assert.equal(name, "pi.cmd");
      return shimPath;
    },
    resolveLocal: async () => {
      throw new Error("must not fall back to the local devDependency");
    },
  });

  assert.equal(resolved, sdkPath);
});

test("does not trust an adjacent package with a different manifest name", async (t) => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-host-sdk-wrong-name-"));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  const shimPath = join(prefix, "pi.cmd");
  await writeFile(shimPath, "@echo off\r\n");
  await makePackage(join(prefix, "node_modules", ...PACKAGE_NAME.split("/")), "not-pi");
  const fallback = join(prefix, "trusted-fallback.js");

  const resolved = await resolveHostPiCodingAgent({
    platform: "win32",
    locatePiBin: async () => shimPath,
    resolveLocal: async () => fallback,
  });

  assert.equal(resolved, fallback);
});

test("preserves Unix CLI symlink-target ancestor discovery", async (t) => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-host-sdk-unix-"));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  const packageRoot = join(prefix, "node_modules", ...PACKAGE_NAME.split("/"));
  const sdkPath = await makePackage(packageRoot);
  const cliPath = join(packageRoot, "dist", "cli.js");
  await writeFile(cliPath, "export {};\n");

  const resolved = await resolveHostPiCodingAgent({
    platform: "darwin",
    locatePiBin: async (name) => {
      assert.equal(name, "pi");
      return cliPath;
    },
    resolveLocal: async () => {
      throw new Error("must not fall back to the local devDependency");
    },
  });

  assert.equal(resolved, sdkPath);
});

test("uses the package's ESM import export for the local fallback", async () => {
  const expected = fileURLToPath(import.meta.resolve(PACKAGE_NAME));
  const resolved = await resolveHostPiCodingAgent({
    locatePiBin: async () => {
      throw new Error("pi is not on PATH");
    },
  });

  assert.equal(resolved, expected);
});
