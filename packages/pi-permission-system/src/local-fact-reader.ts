import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";
import type { PathNormalizer } from "./path-normalizer";
import type { LocalFactRequest, LocalFactResult } from "./service";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
// No dotfiles/stores or filenames suggesting credentials, even inside cwd.
const SENSITIVE_SEGMENT = /^(?:\..*|.*(?:secret|credential|password|passwd|token|cookie|oauth|auth|private[-_]?key|keychain|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.(?:pem|key|p12|pfx)).*)$/i;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/;

/**
 * Bounded local read. Node path/fd checks reduce races but cannot sandbox a
 * hostile process mutating parent directories between checks and open.
 */
export async function readLocalFact(
  request: LocalFactRequest,
  agentName: string | undefined,
  checkPermission: (surface: string, value?: string, agent?: string) => { state: string; matchedPattern?: string },
  normalizer: PathNormalizer,
): Promise<LocalFactResult> {
  const fail = (code: string): LocalFactResult => ({ ok: false, code });
  try {
    if (request === null || typeof request !== "object" || isProxy(request)) return fail("invalid-request");
    const descriptors = Object.getOwnPropertyDescriptors(request);
    if (Reflect.ownKeys(descriptors).some((key) => key !== "kind" && key !== "path")) return fail("invalid-request");
    for (const key of ["kind", "path"] as const) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail("invalid-request");
    }
    const kind = descriptors.kind.value;
    const requestPath = descriptors.path.value;
    if ((kind !== "metadata" && kind !== "text") || typeof requestPath !== "string" || requestPath.length === 0) return fail("invalid-request");

    const flavor = normalizer.flavor;
    const windows = flavor.impl === path.win32;
    const networkPath = (value: string) => /^(?:\\\\|\/\/)/.test(value);
    const lexicalBase = normalizer.resolveBase("");
    const canonicalBase = normalizer.canonicalWorkingDirectory();
    if (!canonicalBase || (windows && [requestPath, lexicalBase, canonicalBase].some(networkPath))) return fail("unsupported-path");
    const suppliedAbs = flavor.impl.resolve(lexicalBase, requestPath);
    if (!normalizer.isWithinDirectory(suppliedAbs, lexicalBase)) return fail("outside-session-cwd");
    // A trusted session cwd can itself be an OS alias (e.g. macOS /var →
    // /private/var). Replace only that captured prefix, never a requested
    // child component, before inspecting symlinks or opening a file.
    const lexicalAbs = flavor.impl.resolve(canonicalBase, flavor.impl.relative(lexicalBase, suppliedAbs));
    if (!normalizer.isWithinDirectory(lexicalAbs, canonicalBase)) return fail("outside-session-cwd");
    const sensitive = (value: string) => value.split(/[\\/]+/).filter(Boolean).some((part) => SENSITIVE_SEGMENT.test(part));
    if (sensitive(lexicalAbs)) return fail("sensitive-path");

    const parsed = flavor.impl.parse(lexicalAbs);
    let cursor = parsed.root;
    let finalInfo;
    for (const component of lexicalAbs.slice(parsed.root.length).split(flavor.impl.sep).filter(Boolean)) {
      cursor = flavor.impl.join(cursor, component);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return fail("symlink-component");
      finalInfo = info;
    }
    if (!finalInfo?.isFile()) return fail("not-regular-file");

    if (checkPermission("read", requestPath, agentName).state !== "allow") return fail("read-not-allowed");
    const explicitPath = checkPermission("path", requestPath, agentName);
    if (explicitPath.matchedPattern !== undefined && explicitPath.state !== "allow") return fail("path-not-allowed");
    const accessPath = normalizer.forPath(requestPath);
    const canonicalPath = accessPath.boundaryValue();
    if (flavor.fold(canonicalPath) !== flavor.fold(lexicalAbs)) return fail("path-changed");
    const absPath = lexicalAbs;
    const resolvedBeforeOpen = await realpath(absPath);
    if (flavor.fold(resolvedBeforeOpen) !== flavor.fold(lexicalAbs) || sensitive(resolvedBeforeOpen)) return fail("path-changed");
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(absPath, flags);
    let outcome: LocalFactResult;
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return fail("not-regular-file");
      const resolvedAfterOpen = await realpath(absPath);
      let afterCursor = parsed.root;
      for (const component of absPath.slice(parsed.root.length).split(flavor.impl.sep).filter(Boolean)) {
        afterCursor = flavor.impl.join(afterCursor, component);
        if ((await lstat(afterCursor)).isSymbolicLink()) return fail("path-changed");
      }
      const current = await stat(resolvedAfterOpen);
      if (flavor.fold(resolvedAfterOpen) !== flavor.fold(lexicalAbs) || opened.dev !== current.dev || opened.ino !== current.ino) return fail("path-changed");
      const cap = kind === "text" ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
      if (opened.size > cap) return fail("file-too-large");
      if (kind === "metadata") {
        outcome = { ok: true, canonicalPath: resolvedAfterOpen, sizeBytes: opened.size };
      } else {
        const bytes = Buffer.alloc(cap + 1);
        const { bytesRead } = await handle.read(bytes, 0, cap + 1, 0);
        if (bytesRead > cap || bytesRead !== opened.size) return fail("file-changed-or-too-large");
        if (PRIVATE_KEY.test(bytes.subarray(0, bytesRead).toString("utf8"))) return fail("sensitive-content");
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)); }
        catch { return fail("not-utf8"); }
        outcome = { ok: true, canonicalPath: resolvedAfterOpen, sizeBytes: bytesRead, text };
      }
    } finally {
      await handle.close();
    }
    // Policy can change while filesystem I/O is pending; never return bytes
    // after the currently effective read or explicit path rule is revoked.
    if (checkPermission("read", requestPath, agentName).state !== "allow") return fail("policy-changed");
    const currentPath = checkPermission("path", requestPath, agentName);
    if (currentPath.matchedPattern !== undefined && currentPath.state !== "allow") return fail("policy-changed");
    return outcome;
  } catch {
    return fail("filesystem-error");
  }
}
