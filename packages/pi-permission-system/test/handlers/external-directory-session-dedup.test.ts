/**
 * Integration tests verifying that sequential tool calls to the same
 * external path only prompt once — the session-approval recorded by the
 * first call covers the second.
 *
 * Uses real PermissionSession + PermissionResolver + SessionRules so the
 * stateful approval-tracking path is exercised end-to-end.
 */

import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pathFlavorForPlatform } from "#src/path/path-flavor";
import {
  makeApprovingPrompter,
  makeDeduplicatingHandler,
  makeDedupWiring,
  makeExtDirBashEvent,
  makeExtDirToolEvent,
} from "#test/helpers/external-directory-fixtures";
import { makeCtx } from "#test/helpers/handler-fixtures";

const nativeFlavor = pathFlavorForPlatform(process.platform);
const nativeCwd = resolve(sep, "test", "project");
const nativePath = (...parts: string[]) => resolve(sep, ...parts);
const bashPath = (path: string) => path.replaceAll("\\", "/");
const nativeCtx = () => makeCtx({ cwd: nativeCwd });

// ── SDK stub ───────────────────────────────────────────────────────────────
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...original };
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("external-directory session dedup", () => {
  describe("path-bearing tools (read, write, edit)", () => {
    it("does not re-prompt for the same external path after session approval", async () => {
      const { handler, prompter } = makeDeduplicatingHandler(
        undefined,
        nativeFlavor,
      );
      const ctx = nativeCtx();
      const externalPath = nativePath("outside", "project", "data.txt");

      // First call — should prompt
      const event1 = makeExtDirToolEvent("read", externalPath, "tc-1");
      const result1 = await handler.handleToolCall(event1, ctx);
      expect(result1).toEqual({ action: "allow" });
      expect(prompter.escalate).toHaveBeenCalledTimes(1);

      // Second call — same path, should hit session rule, no prompt
      const event2 = makeExtDirToolEvent("read", externalPath, "tc-2");
      const result2 = await handler.handleToolCall(event2, ctx);
      expect(result2).toEqual({ action: "allow" });
      expect(prompter.escalate).toHaveBeenCalledTimes(1);
    });

    it("does not re-prompt for a different file in the same external directory", async () => {
      const { handler, prompter } = makeDeduplicatingHandler(
        undefined,
        nativeFlavor,
      );
      const ctx = nativeCtx();

      // First call — prompt for a file in the external project directory.
      const event1 = makeExtDirToolEvent(
        "read",
        nativePath("outside", "project", "a.txt"),
        "tc-1",
      );
      await handler.handleToolCall(event1, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(1);

      // Second call is for a different file in the same directory.
      const event2 = makeExtDirToolEvent(
        "read",
        nativePath("outside", "project", "b.txt"),
        "tc-2",
      );
      await handler.handleToolCall(event2, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(1);
    });

    it("does prompt for a file in a different external directory", async () => {
      const { handler, prompter } = makeDeduplicatingHandler(
        undefined,
        nativeFlavor,
      );
      const ctx = nativeCtx();

      // First call targets one external directory.
      const event1 = makeExtDirToolEvent(
        "read",
        nativePath("outside", "alpha", "file.txt"),
        "tc-1",
      );
      await handler.handleToolCall(event1, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(1);

      // Second call targets a different external directory.
      const event2 = makeExtDirToolEvent(
        "read",
        nativePath("outside", "beta", "file.txt"),
        "tc-2",
      );
      await handler.handleToolCall(event2, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(2);
    });

    it("re-prompts when user approved once (not for session)", async () => {
      const approveOnce = makeApprovingPrompter();
      const { handler, prompter } = makeDeduplicatingHandler(
        approveOnce,
        nativeFlavor,
      );
      const ctx = nativeCtx();
      const externalPath = nativePath("outside", "project", "data.txt");

      // First call — prompt, approved once
      const event1 = makeExtDirToolEvent("read", externalPath, "tc-1");
      await handler.handleToolCall(event1, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(1);

      // Second call — no session rule recorded, should prompt again
      const event2 = makeExtDirToolEvent("read", externalPath, "tc-2");
      await handler.handleToolCall(event2, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(2);
    });
  });

  describe("bash commands with external paths", () => {
    it("does not re-prompt for a bash command referencing the same external path after session approval", async () => {
      const { handler, prompter } = makeDeduplicatingHandler(
        undefined,
        nativeFlavor,
      );
      const ctx = nativeCtx();
      const externalPath = bashPath(nativePath("tmp", "out.txt"));

      // First call references a native external path.
      const event1 = makeExtDirBashEvent(
        `echo hello > ${externalPath}`,
        "tc-1",
      );
      const result1 = await handler.handleToolCall(event1, ctx);
      expect(result1).toEqual({ action: "allow" });
      expect(prompter.escalate).toHaveBeenCalledTimes(1);

      // Second call is a different command referencing the same path.
      const event2 = makeExtDirBashEvent(`cat ${externalPath}`, "tc-2");
      const result2 = await handler.handleToolCall(event2, ctx);
      expect(result2).toEqual({ action: "allow" });
      expect(prompter.escalate).toHaveBeenCalledTimes(1);
    });

    it("does not re-prompt for read after bash already approved the same directory", async () => {
      const { handler, prompter } = makeDeduplicatingHandler(
        undefined,
        nativeFlavor,
      );
      const ctx = nativeCtx();
      const externalPath = nativePath("tmp", "out.txt");

      // First call writes to a native external path.
      const event1 = makeExtDirBashEvent(
        `echo hello > ${bashPath(externalPath)}`,
        "tc-1",
      );
      await handler.handleToolCall(event1, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(1);

      // Second call reads the same path with a different tool.
      const event2 = makeExtDirToolEvent("read", externalPath, "tc-2");
      await handler.handleToolCall(event2, ctx);
      expect(prompter.escalate).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Moved from permission-system.test.ts catch-all (#342)
// ---------------------------------------------------------------------------

describe("session shutdown clears external-directory approvals", () => {
  it("re-prompts for the same path after session shutdown", async () => {
    const { handler, prompter, session } = makeDedupWiring(
      undefined,
      nativeFlavor,
    );

    const externalPath = nativePath("tmp", "sibling", "foo.ts");
    const ctx = nativeCtx();
    const event = makeExtDirToolEvent("read", externalPath, "tc-1");

    // First access: prompt fires and records session approval.
    await handler.handleToolCall(event, ctx);
    expect(vi.mocked(prompter.escalate)).toHaveBeenCalledTimes(1);

    // Second access: covered by session approval — no re-prompt.
    await handler.handleToolCall({ ...event, toolCallId: "tc-2" }, ctx);
    expect(vi.mocked(prompter.escalate)).toHaveBeenCalledTimes(1);

    // Shutdown clears session approvals.
    session.shutdown();

    // Third access: session rules cleared — must re-prompt.
    await handler.handleToolCall({ ...event, toolCallId: "tc-3" }, ctx);
    expect(vi.mocked(prompter.escalate)).toHaveBeenCalledTimes(2);
  });
});
