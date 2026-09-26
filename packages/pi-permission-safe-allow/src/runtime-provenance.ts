import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNKNOWN = "unknown";
const FULL_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface RuntimeProvenance {
  entryPath: string;
  packageRoot: string;
  version: string;
  commit: string;
}

function readPackageRoot(entryPath: string): {
  root: string;
  version: string;
} | undefined {
  let dir = dirname(entryPath);
  for (;;) {
    const packageJson = join(dir, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
      if (
        parsed && typeof parsed === "object" &&
        "name" in parsed && parsed.name === "pi-auto-review"
      ) {
        return {
          root: dir,
          version:
            "version" in parsed && typeof parsed.version === "string" &&
            parsed.version.trim().length > 0
              ? parsed.version
              : UNKNOWN,
        };
      }
    } catch {
      // Continue up to the package root; unreadable metadata is not evidence.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readGitDirs(packageRoot: string): {
  headDir: string;
  refDirs: string[];
} | undefined {
  const dotGit = join(packageRoot, ".git");
  try {
    if (statSync(dotGit).isDirectory()) {
      return { headDir: dotGit, refDirs: [dotGit] };
    }
  } catch {
    return undefined;
  }

  try {
    const gitFile = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(gitFile);
    if (!match?.[1]) return undefined;
    const gitDir = resolve(packageRoot, match[1]);
    const refDirs = [gitDir];
    try {
      const commonDir = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (commonDir) refDirs.push(resolve(gitDir, commonDir));
    } catch {
      // A normal clone has no commondir file.
    }
    return { headDir: gitDir, refDirs };
  } catch {
    return undefined;
  }
}

function commitFromGit(packageRoot: string): string {
  const gitDirs = readGitDirs(packageRoot);
  if (!gitDirs) return UNKNOWN;

  let head: string;
  try {
    head = readFileSync(join(gitDirs.headDir, "HEAD"), "utf8").trim();
  } catch {
    return UNKNOWN;
  }
  if (FULL_COMMIT.test(head)) return head.toLowerCase();

  const ref =
    /^ref: (refs\/(?:heads|tags|remotes)\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!ref || ref.split("/").some((segment) => segment === "..")) return UNKNOWN;
  for (const candidateGitDir of gitDirs.refDirs) {
    try {
      const value = readFileSync(join(candidateGitDir, ref), "utf8").trim();
      if (FULL_COMMIT.test(value)) return value.toLowerCase();
    } catch {
      // Packed refs are checked below.
    }
    try {
      const packedRefs = readFileSync(join(candidateGitDir, "packed-refs"), "utf8");
      for (const line of packedRefs.split(/\r?\n/)) {
        const [sha, packedRef] = line.trim().split(/\s+/, 2);
        if (packedRef === ref && sha && FULL_COMMIT.test(sha)) {
          return sha.toLowerCase();
        }
      }
    } catch {
      // Git metadata may be intentionally omitted from package installs.
    }
  }
  return UNKNOWN;
}

export function getRuntimeProvenance(moduleUrl: string): RuntimeProvenance {
  let entryPath = UNKNOWN;
  try {
    entryPath = fileURLToPath(moduleUrl);
  } catch {
    // An invalid or non-file URL cannot establish a local entry path.
  }

  const packageInfo = entryPath === UNKNOWN ? undefined : readPackageRoot(entryPath);
  const packageRoot = packageInfo?.root ?? UNKNOWN;
  return {
    entryPath,
    packageRoot,
    version: packageInfo?.version ?? UNKNOWN,
    commit: packageInfo ? commitFromGit(packageInfo.root) : UNKNOWN,
  };
}
