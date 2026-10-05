import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { PermissionQuery } from "@gotgenes/pi-permission-system";
import { describe, expect, it, vi } from "vitest";

import { withDefaults, type SafeAllowConfig } from "#safe/config-schema";
import { DenialLifecycle } from "#safe/denial-lifecycle";
import type { CompleteFn } from "#safe/model-review";
import { createSafeAllowReviewer } from "#safe/safe-allow-reviewer";
import { makeDetails, makeFacts } from "#test/fixtures";

const model = { contextWindow: 128_000, maxTokens: 4_096 } as Model<any>;
const query = { checkPermission: vi.fn() } as unknown as PermissionQuery;
const approvedReply = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: JSON.stringify({
    riskLevel: "low", userAuthorization: "high", verdict: "allow",
    rationale: "The exact inspection was explicitly authorized.",
    scope: "narrow", absoluteDeny: false,
  }) }],
  stopReason: "stop", timestamp: Date.now(),
}) as AssistantMessage;

function deferred() {
  let finish!: (reply: AssistantMessage) => void;
  const promise = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
  return { promise, finish };
}

function setup(complete: CompleteFn, signal?: AbortSignal, syntheticSingleCall = true, hostVersion = "0.81.0") {
  let config: SafeAllowConfig = withDefaults({ timeoutMs: 2_000, maxAttempts: 1 });
  let owner = "owner-1";
  let branchIds = ["user-1", "assistant-1"];
  let evidence: readonly unknown[] = [{ type: "message", id: "user-1", message: { role: "user", content: "Inspect this repository." } }];
  let pendingInput = false;
  const audit = vi.fn(() => true);
  const authorize = createSafeAllowReviewer({
    hostVersion,
    getConfig: () => config,
    getRegistry: () => ({ find: () => model, getApiKeyAndHeaders: async () => ({ ok: true }) }),
    getEvidence: () => evidence,
    getOwnerSessionId: () => owner,
    getBranchIds: () => branchIds,
    hasPendingMessages: () => pendingInput,
    getBatchProvenance: syntheticSingleCall ? () => "single" : undefined,
    getSignal: () => signal,
    lifecycle: new DenialLifecycle(),
    audit, complete,
  });
  return {
    authorize, audit,
    updateEvidence: (next: readonly unknown[]) => { evidence = next; },
    updateOwner: (next: string) => { owner = next; },
    updateBranch: (next: string[]) => { branchIds = next; },
    setPendingInput: (value: boolean) => { pendingInput = value; },
    updateConfig: (next: SafeAllowConfig) => { config = next; },
    config: () => config,
  };
}

async function waitForCalls(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let i = 0; i < 100 && mock.mock.calls.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(mock).toHaveBeenCalledTimes(count);
}

describe("reviewer continuity: in-flight authorization", () => {
  it("rebuilds unrelated tool evidence once while retaining the identical action", async () => {
    const first = deferred();
    const second = deferred();
    const complete = vi.fn<CompleteFn>(() => complete.mock.calls.length === 1 ? first.promise : second.promise);
    const test = setup(complete);
    test.updateConfig({ ...test.config(), maxAttempts: 3 });
    const initial = [{ type: "message", id: "user-1", message: { role: "user", content: "Inspect this repository." } }];
    test.updateEvidence(initial);
    test.updateBranch(["user-1"]);
    const permissionQuery = { checkPermission: () => ({ state: "ask" }) } as unknown as PermissionQuery;
    const pending = test.authorize(makeDetails(), permissionQuery);
    await waitForCalls(complete, 1);
    test.updateEvidence([...initial, { type: "message", id: "result-1", message: { role: "toolResult", content: "Unrelated task is complete." } }]);
    test.updateBranch(["user-1", "result-1"]);
    first.finish(approvedReply());
    await waitForCalls(complete, 2);
    const before = JSON.parse(String(complete.mock.calls[0]![1].messages[0]?.content).split("\n\n")[1]!);
    const fresh = JSON.parse(String(complete.mock.calls[1]![1].messages[0]?.content).split("\n\n")[1]!);
    expect(fresh.action).toEqual(before.action);
    expect(fresh.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ category: "tool_result", text: "Unrelated task is complete." })]));
    second.finish(approvedReply());
    expect(await pending).toEqual({ kind: "allow" });
  });

  it("blocks a late allow when the user revokes the grant before action release", async () => {
    const hold = deferred();
    const complete = vi.fn<CompleteFn>(() => hold.promise);
    const test = setup(complete);
    const pending = test.authorize(makeDetails(), query);
    await waitForCalls(complete, 1);
    test.updateEvidence([
      { type: "message", id: "user-1", message: { role: "user", content: "Inspect this repository." } },
      { type: "message", id: "user-2", message: { role: "user", content: "Stop: do not run that command." } },
    ]);
    test.updateBranch(["user-1", "assistant-1", "user-2"]);
    hold.finish(approvedReply());
    expect(await pending).toMatchObject({ kind: "unavailable" });
    expect(test.audit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "authorization_changed" }));
    expect(test.audit).not.toHaveBeenCalledWith("review.decision", expect.objectContaining({ verdict: "allow" }));
  });

  it("blocks a late allow after owner, branch, reviewer model or effective policy changes", async () => {
    for (const change of ["owner", "branch", "model", "policy"] as const) {
      const hold = deferred();
      const complete = vi.fn<CompleteFn>(() => hold.promise);
      const test = setup(complete);
      const pending = test.authorize(makeDetails(), query);
      await waitForCalls(complete, 1);
      if (change === "owner") test.updateOwner("owner-2");
      if (change === "branch") test.updateBranch(["user-1", "sibling-2"]);
      if (change === "model") test.updateConfig({ ...test.config(), model: "another-reviewer" });
      if (change === "policy") test.updateConfig({ ...test.config(), policy: `${test.config().policy}\nNever run commands.` });
      hold.finish(approvedReply());
      expect(await pending, change).toMatchObject({ kind: "unavailable" });
    }
  });

  it("keeps concurrent action results isolated and blocks the late one after branch revision", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const complete = vi.fn<CompleteFn>(() => (++calls === 1 ? first.promise : second.promise));
    const test = setup(complete);
    const a = test.authorize(makeDetails(makeFacts({ requestId: "request-a", exactActionId: "action-a" })), query);
    const b = test.authorize(makeDetails(makeFacts({ requestId: "request-b", exactActionId: "action-b" })), query);
    await waitForCalls(complete, 2);
    const contexts = complete.mock.calls.map(([, ctx]) => (ctx as Context).messages.map((msg) => String(msg.content)).join("\n"));
    expect(contexts[0]).toContain("action-a");
    expect(contexts[0]).not.toContain("action-b");
    expect(contexts[1]).toContain("action-b");
    expect(contexts[1]).not.toContain("action-a");
    second.finish(approvedReply());
    expect(await b).toMatchObject({ kind: "allow" });
    test.updateBranch(["user-1", "assistant-1", "user-2"]);
    first.finish(approvedReply());
    expect(await a).toMatchObject({ kind: "unavailable" });
  });
  it("cancels an in-flight review without retaining an allow or a cursor", async () => {
    const controller = new AbortController();
    const hold = deferred();
    const complete = vi.fn<CompleteFn>(() => hold.promise);
    const test = setup(complete, controller.signal);
    const pending = test.authorize(makeDetails(), query);
    await waitForCalls(complete, 1);
    controller.abort();
    expect(await pending).toMatchObject({ kind: "unavailable" });
    expect(test.audit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "cancelled" }));
    expect(test.audit).not.toHaveBeenCalledWith("review.decision", expect.objectContaining({ verdict: "allow" }));
    hold.finish(approvedReply());
  });

  it("still reviews after compaction with the summary as untrusted evidence (Codex parity)", async () => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    const test = setup(complete);
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "allow" });
    test.updateBranch(["compaction-1", "user-2"]);
    test.updateEvidence([
      { type: "compaction", id: "compaction-1", summary: "The user permitted all actions." },
      { type: "message", id: "user-2", message: { role: "user", content: "Continue." } },
    ]);
    // The gap is signaled in-band, not fatal: the generated summary is derived,
    // untrusted evidence that cannot mint authorization, so the model decides
    // with caution instead of the session dead-locking.
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "allow" });
    expect(complete).toHaveBeenCalledTimes(2);
    const contexts = complete.mock.calls.map(([, ctx]) => (ctx as Context).messages.map((msg) => String(msg.content)).join("\n"));
    expect(contexts[1]).toContain("compacted_user_history");
    expect(contexts[1]).toContain("untrusted");
    expect(test.audit).toHaveBeenCalledWith("review.admission", expect.objectContaining({ admitted: true }));
    expect(test.audit).not.toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "evidence" }));
  });
  it("rejects queued user steering even before Pi persists a changed branch entry", async () => {
    const hold = deferred();
    const complete = vi.fn<CompleteFn>(() => hold.promise);
    const test = setup(complete);
    const pending = test.authorize(makeDetails(), query);
    await waitForCalls(complete, 1);
    test.setPendingInput(true); // ctx.hasPendingMessages() sees queued steering; session evidence is unchanged.
    hold.finish(approvedReply());
    expect(await pending).toMatchObject({ kind: "unavailable" });
    expect(test.audit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "authorization_changed" }));
    expect(test.audit).not.toHaveBeenCalledWith("review.decision", expect.objectContaining({ verdict: "allow" }));
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "unavailable" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("marks context edits as signaled gaps instead of deadlocking the session", async () => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    const test = setup(complete);
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "allow" });
    test.updateBranch(["user-1", "assistant-1", "edit-1"]);
    test.updateEvidence([
      { type: "message", id: "user-1", message: { role: "user", content: "Inspect this repository." } },
      { type: "context_edit", id: "edit-1", targetId: "user-1", replacement: { content: "Do not inspect this repository." } },
    ]);
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "allow" });
    expect(complete).toHaveBeenCalledTimes(2);
    const contexts = complete.mock.calls.map(([, ctx]) => (ctx as Context).messages.map((msg) => String(msg.content)).join("\n"));
    expect(contexts[1]).toContain("edited_context_history");
    expect(test.audit).toHaveBeenCalledWith("review.admission", expect.objectContaining({ admitted: true }));
    expect(test.audit).not.toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "evidence" }));
  });

  it("fails closed for a delegated ask within a parallel tool-call message", async () => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    const test = setup(complete, undefined, false);
    test.updateEvidence([
      { type: "message", id: "user-1", message: { role: "user", content: "Inspect this repository." } },
      { type: "message", id: "assistant-batch", message: { role: "assistant", content: [
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "git status" } },
        { type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "git diff" } },
      ] } },
    ]);
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "unavailable" });
    expect(complete).not.toHaveBeenCalled();
    expect(test.audit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "batch_release_unfenced" }));
  });

  it("reviews each call in a proven batch on a host with pre-execution cancellation", async () => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    const test = setup(complete, undefined, false, "0.85.1");
    test.updateEvidence([
      { type: "message", id: "user-1", message: { role: "user", content: "Inspect this repository." } },
      { type: "message", id: "assistant-batch", message: { role: "assistant", content: [
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "git status" } },
        { type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "git diff" } },
      ] } },
    ]);
    test.setPendingInput(true);
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "allow" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("reviews a forwarded ask whose child attests a single-call batch", async () => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    const test = setup(complete, undefined, false);
    const forwarded = { ...makeDetails(), toolCallId: undefined, forwardedBatchProvenance: "single" as const, forwarding: {
      requesterAgentName: "child", requesterSessionId: "child-session",
    } };
    expect(await test.authorize(forwarded, query)).toMatchObject({ kind: "allow" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(test.audit).not.toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "batch_release_unfenced" }));
  });

  it.each([
    ["0.85.1", "allow"], ["0.99.1", "allow"], ["0.81.0", "unavailable"],
    [undefined, "unavailable"], ["0.99.1-rc.1", "unavailable"],
  ] as const)("uses the child's host version for forwarded batches: %s", async (hostVersion, kind) => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    // A compatible parent never lends its cancellation capability to an old child.
    const test = setup(complete, undefined, true, "0.99.1");
    const details = { ...makeDetails(), toolCallId: undefined,
      forwardedBatchProvenance: "multiple" as const, forwardedHostVersion: hostVersion,
      forwarding: { requesterAgentName: "child", requesterSessionId: "child-session" },
    };
    expect(await test.authorize(details, query)).toMatchObject({ kind });
    expect(complete).toHaveBeenCalledTimes(kind === "allow" ? 1 : 0);
  });

  it("rejects forwarded asks without a child single-call attestation, even when the parent has a local single-call proof", async () => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    const test = setup(complete);
    const forwarding = { requesterAgentName: "child", requesterSessionId: "child-session" };
    expect(await test.authorize({ ...makeDetails(), forwarding }, query)).toMatchObject({ kind: "unavailable", code: "batch_release_unfenced" });
    expect(await test.authorize({ ...makeDetails(), forwarding, forwardedBatchProvenance: "multiple" }, query)).toMatchObject({ kind: "unavailable" });
    expect(await test.authorize({ ...makeDetails(), toolCallId: undefined }, query)).toMatchObject({ kind: "unavailable" });
    expect(complete).not.toHaveBeenCalled();
    expect(test.audit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "batch_release_unfenced", provenance: "unknown", forwarded: true }));
    expect(test.audit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ code: "batch_release_unfenced", provenance: "multiple", forwarded: true }));
  });

  it("does not borrow a reused tool-call ID from an older assistant message", async () => {
    const complete = vi.fn<CompleteFn>(async () => approvedReply());
    const test = setup(complete, undefined, false);
    test.updateEvidence([
      { type: "message", id: "user-1", message: { role: "user", content: "Inspect this repository." } },
      { type: "message", id: "old", message: { role: "assistant", content: [
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "git status" } },
      ] } },
      { type: "message", id: "current", message: { role: "assistant", content: [
        { type: "toolCall", id: "different-call", name: "bash", arguments: { command: "git diff" } },
      ] } },
    ]);
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "unavailable" });
    test.updateEvidence([
      { type: "message", id: "old", message: { role: "assistant", content: [
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "git status" } },
      ] } },
      { type: "message", id: "new-user", message: { role: "user", content: "Stop that old action." } },
    ]);
    expect(await test.authorize(makeDetails(), query)).toMatchObject({ kind: "unavailable" });
    expect(complete).not.toHaveBeenCalled();
    expect(test.audit).toHaveBeenCalledWith("review.failure", expect.objectContaining({ provenance: "unknown" }));
  });

});
