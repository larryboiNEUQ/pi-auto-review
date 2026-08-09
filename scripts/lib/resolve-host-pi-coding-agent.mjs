import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_SEGMENTS = PACKAGE_NAME.split("/");

async function sdkFromPackageRoot(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== PACKAGE_NAME) return undefined;

  const sdkPath = join(packageRoot, "dist", "index.js");
  if (!existsSync(sdkPath)) return undefined;
  return realpath(sdkPath);
}

async function resolveLocalSdk() {
  return realpath(fileURLToPath(import.meta.resolve(PACKAGE_NAME)));
}

/**
 * Resolve the host Pi SDK used by the Git bundle smoke test.
 *
 * The PATH lookup is injected so this filesystem resolver can be regression-tested
 * without changing the process PATH. Windows npm installs expose a .cmd shim next
 * to node_modules; Unix installs normally expose a symlink into the package itself.
 */
export async function resolveHostPiCodingAgent({
  platform = process.platform,
  locatePiBin,
  resolveLocal = resolveLocalSdk,
}) {
  try {
    const binPath = await locatePiBin(platform === "win32" ? "pi.cmd" : "pi");
    if (binPath) {
      const realBin = await realpath(binPath);

      // Windows npm global: <prefix>/pi.cmd beside <prefix>/node_modules/<package>.
      const adjacentPackage = join(dirname(binPath), "node_modules", ...PACKAGE_SEGMENTS);
      const adjacentSdk = await sdkFromPackageRoot(adjacentPackage);
      if (adjacentSdk) return adjacentSdk;

      // Unix npm global: the PATH entry is generally a symlink into dist/cli.js.
      let current = dirname(realBin);
      for (let i = 0; i < 8; i += 1) {
        const sdkPath = await sdkFromPackageRoot(current);
        if (sdkPath) return sdkPath;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  } catch {
    // PATH discovery is best-effort; local development uses the devDependency.
  }

  // Use ESM resolution because the package root is exported for "import", not "require".
  return resolveLocal();
}
