import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSafeAllowExtension } from "#safe/extension";
import { getRuntimeProvenance } from "#safe/runtime-provenance";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-review-provenance-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runtime provenance", () => {
  it("reports the package root, version, and commit belonging to the loaded entry", () => {
    const root = temporaryRoot();
    const entryPath = join(root, "index.js");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "pi-auto-review",
      version: "7.8.9",
    }));
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${commit}\n`);

    expect(getRuntimeProvenance(pathToFileURL(entryPath).href)).toEqual({
      entryPath,
      packageRoot: root,
      version: "7.8.9",
      commit,
    });
  });

  it("marks package metadata and Git identity unknown when unavailable", () => {
    const root = temporaryRoot();
    const entryPath = join(root, "extensions", "index.js");
    mkdirSync(join(root, "extensions"), { recursive: true });
    writeFileSync(join(root, "package.json"), "not json");

    expect(getRuntimeProvenance(pathToFileURL(entryPath).href)).toEqual({
      entryPath,
      packageRoot: "unknown",
      version: "unknown",
      commit: "unknown",
    });
  });

  it("writes provenance to the startup JSONL record", () => {
    const agentDir = join(temporaryRoot(), "pi-agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const pi = {
      on: vi.fn(),
      events: { on: vi.fn() },
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;

    createSafeAllowExtension(pi);

    const logPath = join(
      agentDir,
      "extensions",
      "pi-permission-safe-allow",
      "logs",
      "safe-allow.jsonl",
    );
    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const provenance = records.find((record) => record.event === "runtime.provenance");

    expect(provenance).toMatchObject({
      extension: "pi-permission-safe-allow",
      event: "runtime.provenance",
      entryPath: expect.stringContaining("extension.ts"),
      packageRoot: expect.stringContaining("pi-auto-review-issue41"),
      version: "2.2.0",
      commit: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    });
    expect(JSON.stringify(provenance)).not.toMatch(/token|secret|credential|api.?key/i);
  });

  it("identifies the package root and version from the built Pi entry", async () => {
    const agentDir = join(temporaryRoot(), "pi-agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const bundlePath = join(repoRoot, "..", "..", "index.js");
    const manifest = JSON.parse(
      readFileSync(join(dirname(bundlePath), "package.json"), "utf8"),
    );
    const pi = {
      on: vi.fn(),
      events: { on: vi.fn() },
      registerCommand: vi.fn(),
    };
    const { default: extension } = await import(
      /* @vite-ignore */ pathToFileURL(bundlePath).href
    );

    extension(pi);

    const logPath = join(
      agentDir,
      "extensions",
      "pi-permission-safe-allow",
      "logs",
      "safe-allow.jsonl",
    );
    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const provenance = records.find((record) => record.event === "runtime.provenance");

    expect(provenance).toMatchObject({
      entryPath: bundlePath,
      packageRoot: dirname(bundlePath),
      version: manifest.version,
      commit: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    });
  });
});
