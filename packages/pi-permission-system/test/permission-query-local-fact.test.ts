import { rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathFlavorForPlatform, win32PathFlavor } from "#src/path/path-flavor";
import { readLocalFact } from "#src/local-fact-reader";
import { PathNormalizer } from "#src/path-normalizer";
import { LocalPermissionsService } from "#src/permissions-service";
import type { PermissionCheckResult } from "#src/types";

const makeResult = (state: "allow" | "ask" | "deny", matchedPattern?: string): PermissionCheckResult => ({
  state,
  toolName: "read",
  source: "default",
  origin: "global",
  ...(matchedPattern === undefined ? {} : { matchedPattern }),
});

describe("LocalPermissionsService.readPermittedLocalFact", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function setup(read: PermissionCheckResult = makeResult("allow"), explicit: PermissionCheckResult = makeResult("allow"), onResolve?: (surface: string) => void) {
    root = await mkdtemp(path.join(tmpdir(), "permission-query-"));
    const resolver = {
      resolve: (intent: { surface: string }) => { onResolve?.(intent.surface); return intent.surface === "read" ? read : explicit; },
      getToolPermission: () => "allow" as const,
    };
    const registry = { register: () => () => {} };
    const service = new LocalPermissionsService(
      resolver as never,
      { getPathNormalizer: () => new PathNormalizer(pathFlavorForPlatform(process.platform), root) },
      registry as never, registry as never, registry as never,
    );
    return { service, file: path.join(root, "note.txt") };
  }

  it("returns bounded metadata and UTF-8 text for a permitted regular file", async () => {
    const { service, file } = await setup();
    await writeFile(file, "hello", "utf8");
    if (process.platform === "win32") {
      const normalizer = new PathNormalizer(pathFlavorForPlatform(process.platform), root);
      const base = normalizer.resolveBase("");
      const canonicalBase = normalizer.canonicalWorkingDirectory();
      const lexicalAbs = path.resolve(canonicalBase, path.relative(base, file));
      const native = await realpath(lexicalAbs);
      const handle = await open(lexicalAbs, "r");
      try {
        const opened = await handle.stat();
        const current = await stat(native);
        console.error("[DEBUG-i50-win]", JSON.stringify({ base, canonicalBase, lexicalAbs, access: normalizer.forPath(file).boundaryValue(), nativeBase: await realpath(root), native, opened: { dev: opened.dev, ino: opened.ino }, current: { dev: current.dev, ino: current.ino } }));
      } finally { await handle.close(); }
    }
    const metadata = await service.readPermittedLocalFact({ kind: "metadata", path: file });
    expect(metadata).toEqual({ ok: true, canonicalPath: await realpath(file), sizeBytes: 5 });
    expect(metadata).not.toHaveProperty("text");
    expect(await service.readPermittedLocalFact({ kind: "text", path: file })).toMatchObject({ ok: true, text: "hello" });
  });

  it.each(["deny", "ask"] as const)("refuses read policy %s", async state => {
    const { service, file } = await setup(makeResult(state));
    await writeFile(file, "hello");
    expect(await service.readPermittedLocalFact({ kind: "text", path: file })).toMatchObject({ ok: false });
  });

  it.each(["deny", "ask"] as const)("refuses explicit path policy %s", async state => {
    const { service, file } = await setup(makeResult("allow"), makeResult(state, "some-pattern"));
    await writeFile(file, "hello");
    expect(await service.readPermittedLocalFact({ kind: "metadata", path: file })).toMatchObject({ ok: false });
  });

  it("refuses outside paths, symlink components, and credential names", async () => {
    const { service, file } = await setup();
    const outside = path.join(tmpdir(), `outside-${path.basename(root)}.txt`);
    await writeFile(outside, "secret");
    await expect(service.readPermittedLocalFact({ kind: "text", path: outside })).resolves.toMatchObject({ ok: false });
    await symlink(outside, path.join(root, "link.txt"));
    await expect(service.readPermittedLocalFact({ kind: "text", path: path.join(root, "link.txt") })).resolves.toMatchObject({ ok: false });
    await writeFile(path.join(root, ".env"), "secret");
    await expect(service.readPermittedLocalFact({ kind: "text", path: path.join(root, ".env") })).resolves.toMatchObject({ ok: false });
    await writeFile(path.join(root, ".npmrc"), "//registry:authToken=secret");
    await expect(service.readPermittedLocalFact({ kind: "text", path: path.join(root, ".npmrc") })).resolves.toMatchObject({ ok: false, code: "sensitive-path" });
    await writeFile(path.join(root, "oauth-session.json"), "secret");
    await expect(service.readPermittedLocalFact({ kind: "text", path: path.join(root, "oauth-session.json") })).resolves.toMatchObject({ ok: false, code: "sensitive-path" });
    await writeFile(file, "ok");
    await rm(outside, { force: true });
  });

  it("refuses binary and oversized text", async () => {
    const { service, file } = await setup();
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    await expect(service.readPermittedLocalFact({ kind: "text", path: file })).resolves.toMatchObject({ ok: false });
    await writeFile(file, "x".repeat(5000));
    await expect(service.readPermittedLocalFact({ kind: "text", path: file })).resolves.toMatchObject({ ok: false });
  });

  it("resolves relative paths against the session cwd", async () => {
    const { service } = await setup();
    await writeFile(path.join(root, "relative.txt"), "session");
    expect(await service.readPermittedLocalFact({ kind: "text", path: "relative.txt" })).toEqual({ ok: true, canonicalPath: await realpath(path.join(root, "relative.txt")), sizeBytes: 7, text: "session" });
  });

  it.each(["read", "path"] as const)("discards a fact when %s permission is revoked during I/O", async surface => {
    const read = makeResult("allow");
    const pathRule = makeResult("allow", "explicit-path");
    let queued = false;
    const { service, file } = await setup(read, pathRule, (current) => {
      if (current !== surface || queued) return;
      queued = true;
      queueMicrotask(() => { (surface === "read" ? read : pathRule).state = "deny"; });
    });
    await writeFile(file, "a fact");
    expect(await service.readPermittedLocalFact({ kind: "text", path: file }))
      .toMatchObject({ ok: false, code: "policy-changed" });
  });

  it("rejects a file replaced with a symlink after the read policy check", async () => {
    const link = () => path.join(root, "note.txt");
    let replaced = false;
    const { service, file } = await setup(makeResult("allow"), makeResult("allow"), (surface) => {
      if (surface === "read" && !replaced) {
        replaced = true;
        rmSync(link());
        symlinkSync(path.join(root, "denied.txt"), link());
      }
    });
    await writeFile(file, "allowed");
    await writeFile(path.join(root, "denied.txt"), "secret");
    expect(await service.readPermittedLocalFact({ kind: "text", path: file })).toMatchObject({ ok: false, code: "path-changed" });
  });

  it.skipIf(process.platform === "win32")("does not open a FIFO waiting for a writer", async () => {
    const { service, file } = await setup();
    execFileSync("mkfifo", [file], { timeout: 1000 });
    expect(await service.readPermittedLocalFact({ kind: "text", path: file })).toMatchObject({ ok: false, code: "not-regular-file" });
  });

  it("rejects Windows UNC before consulting policy or filesystem", async () => {
    let checks = 0;
    const normalizer = new PathNormalizer(win32PathFlavor, "C:\\workspace");
    const outcome = await readLocalFact({ kind: "text", path: "\\\\attacker-host\\share\\note.txt" }, undefined, () => { checks++; return { state: "allow" }; }, normalizer);
    expect(outcome).toMatchObject({ ok: false, code: "unsupported-path" });
    expect(checks).toBe(0);
  });

  it("refuses private-key names and recognized key content", async () => {
    const { service, file } = await setup();
    const key = path.join(root, "id_ecdsa");
    await writeFile(key, "KEY");
    expect(await service.readPermittedLocalFact({ kind: "text", path: key })).toMatchObject({ ok: false, code: "sensitive-path" });
    await writeFile(file, "-----BEGIN OPENSSH PRIVATE KEY-----\nvalue");
    expect(await service.readPermittedLocalFact({ kind: "text", path: file })).toMatchObject({ ok: false, code: "sensitive-content" });
  });

  it("rejects accessor-backed requests without invoking getters", async () => {
    const { service } = await setup();
    let invoked = false;
    const request = Object.defineProperties({}, {
      kind: { enumerable: true, get() { invoked = true; return "text"; } },
      path: { enumerable: true, value: "relative.txt" },
    });
    await expect(service.readPermittedLocalFact(request as never)).resolves.toMatchObject({ ok: false, code: "invalid-request" });
    expect(invoked).toBe(false);
  });
});
