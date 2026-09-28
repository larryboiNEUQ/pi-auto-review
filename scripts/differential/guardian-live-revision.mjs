import * as esbuild from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY = `
export { GUARDIAN_POLICY_VERSION, withDefaults } from "./config-schema.ts";
export { buildApprovalDossier } from "./dossier.ts";
export { reviewDossier } from "./model-review.ts";
export { parseReviewerDecision } from "./review-contract.ts";
`;

function permissionAliasPlugin(nodeModules) {
  const permissionSrc = join(nodeModules, "@gotgenes/pi-permission-system/src");
  const resolveTs = (basePath) => {
    for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.js`, join(basePath, "index.ts")]) {
      if (existsSync(candidate)) return candidate;
    }
    return `${basePath}.ts`;
  };
  return {
    name: "guardian-live-permission-alias",
    setup(build) {
      build.onResolve({ filter: /^@gotgenes\/pi-permission-system$/ }, () => ({
        path: join(permissionSrc, "authority/delegated-approval-facts.ts"),
      }));
      build.onResolve({ filter: /^#src\// }, (args) => ({
        path: resolveTs(join(permissionSrc, args.path.slice("#src/".length))),
      }));
    },
  };
}

export async function bundleRevisionSource(srcDir, outfile, nodeModules) {
  await mkdir(join(outfile, ".."), { recursive: true });
  const result = await esbuild.build({
    stdin: {
      contents: ENTRY,
      resolveDir: srcDir,
      sourcefile: "guardian-live-entry.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    external: [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-ai/*",
      "@earendil-works/pi-coding-agent",
      "@gotgenes/pi-permission-system",
      "ai",
    ],
    loader: { ".ts": "ts" },
    tsconfigRaw: {
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
      },
    },
    nodePaths: nodeModules ? [nodeModules] : [],
    plugins: nodeModules ? [permissionAliasPlugin(nodeModules)] : [],
    logLevel: "silent",
  });
  if (result.errors.length) throw new Error("Revision bundle failed.");
  await writeFile(outfile, result.outputFiles[0].text);
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

export async function materializeRevision(root, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Revision commit must be a full SHA.");
  execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
  const dir = await mkdtemp(join(tmpdir(), "guardian-rev-"));
  const archive = execFileSync("git", ["archive", commit, "packages/pi-permission-safe-allow/src"], { cwd: root });
  const extracted = spawnSync("tar", ["-x", "-C", dir], { input: archive });
  if (extracted.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("Could not extract the pinned revision source.");
  }
  return { dir, srcDir: join(dir, "packages/pi-permission-safe-allow/src"), async cleanup() { await rm(dir, { recursive: true, force: true }); } };
}
