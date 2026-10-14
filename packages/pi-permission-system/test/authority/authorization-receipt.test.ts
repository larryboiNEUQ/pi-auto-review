import { describe, expect, it } from "vitest";

import { authorizationBranchIds } from "#src/authority/authorization-branch";
import { composeAuthorizerChain } from "#src/authority/authorizer-chain";
import {
  authorizationSnapshot, authorizationTransition, consumeApprovalReceipt,
  hasApprovalReceipt, isAutomatedApproval, sealApproval,
} from "#src/authority/authorization-receipt";
import {
  bindForwardedReview, forwardedRequesterIsCurrent, forwardedReviewIsCurrent,
  forwardedSnapshot, forwardedTransition,
} from "#src/authority/forwarded-freshness";
import { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import type { PermissionQuery } from "#src/service";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";

const entry = (id: string, role: string, content = "Progress.") => ({ type: "message", id, message: { role, content } });
const snapshot = (entries: readonly unknown[]) => authorizationSnapshot("owner", authorizationBranchIds(entries as ReturnType<typeof entry>[]), { policy: "inspect" }, entries);

describe("authorization snapshots", () => {
  it("allows only assistant and tool results after the identical immutable prefix", () => {
    const entries = [entry("user", "user", "Inspect.")];
    const before = snapshot(entries);
    entries.push(entry("assistant", "assistant"), entry("result", "toolResult"));
    expect(authorizationTransition(before, snapshot(entries))).toEqual({ kind: "append-only" });
    entries[0]!.message.content = "Revoke!";
    expect(authorizationTransition(before, snapshot(entries))).toEqual({ kind: "hard", dimension: "history" });
  });

  it.each(["user", "developer", "system", "unknown"])("treats appended %s as a hard change", (role) => {
    const entries = [entry("user", "user")];
    expect(authorizationTransition(snapshot(entries), snapshot([...entries, entry("new", role)]))).toEqual({ kind: "hard", dimension: "history" });
  });

  it.each(["compaction", "context_edit", "unrecognized"])("treats appended %s entries as a hard change", (type) => {
    const entries = [entry("user", "user")];
    expect(authorizationTransition(snapshot(entries), snapshot([...entries, { type, id: "new" }]))).toEqual({ kind: "hard", dimension: "history" });
  });

  it("preserves metadata semantics but rejects incomplete branch provenance", () => {
    const entries = [entry("user", "user")];
    const before = snapshot(entries);
    expect(authorizationTransition(before, snapshot([...entries, { type: "session_info", id: "title", name: "Work" }]))).toEqual({ kind: "unchanged" });
    expect(authorizationTransition(before, authorizationSnapshot("owner", ["user", "invented"], { policy: "inspect" }, [...entries, entry("actual", "assistant")]))).toEqual({ kind: "hard", dimension: "branch" });
  });
});

describe("local approval receipts", () => {
  it.each(["valid", "wrong-request", "wrong-action", "wrong-owner", "wrong-branch", "expired", "stale", "inactive", "fake", "clone", "defer", "throwing-current"])(
    "commits only a current action-bound receipt at final consumption: %s", async (scenario) => {
      let commits = 0;
      const verdict = { kind: "allow" as const };
      sealApproval(verdict, {
        requestId: "request", exactActionId: "action", ownerSessionId: "owner", branchIds: ["user"],
        deadline: scenario === "expired" ? 0 : Date.now() + 10_000,
        isCurrent: () => {
          if (scenario === "throwing-current") throw new Error("Unavailable host snapshot.");
          return scenario !== "stale";
        },
        commit: () => { commits++; },
      });
      const chain = composeAuthorizerChain([{ authorize: async () => scenario === "defer" ? { kind: "defer" }
        : scenario === "fake" ? { kind: "allow", receipt: { isCurrent: () => true } }
        : scenario === "clone" ? { ...verdict } : verdict }],
      { authorize: async () => ({ approved: true, state: "approved" }) }, {} as PermissionQuery);
      const decision = await chain.authorize({} as PromptPermissionDetails);
      expect(decision).toEqual({ approved: true, state: "approved" });
      expect(commits).toBe(0);
      const identity = {
        requestId: scenario === "wrong-request" ? "other" : "request",
        exactActionId: scenario === "wrong-action" ? "other" : "action",
        ownerSessionId: scenario === "wrong-owner" ? "other" : "owner",
        branchIds: scenario === "wrong-branch" ? ["other"] : ["user"],
      };
      expect(hasApprovalReceipt(decision)).toBe(!["fake", "clone", "defer"].includes(scenario));
      expect(isAutomatedApproval(decision)).toBe(scenario !== "defer");
      expect(consumeApprovalReceipt(decision, identity, scenario !== "inactive")).toBe(scenario === "valid");
      expect(commits).toBe(scenario === "valid" ? 1 : 0);
      expect(consumeApprovalReceipt(decision, { requestId: "request", exactActionId: "action", ownerSessionId: "owner", branchIds: ["user"] }, true)).toBe(false);
      expect(commits).toBe(scenario === "valid" ? 1 : 0);
    },
  );
});

describe("forwarded freshness and requester liveness", () => {
  const builtinRead = [{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } }];

  it("ignores non-authorizing bookkeeping entries during paired builtin read progress", () => {
    const base = [entry("user", "user", "Inspect."), { type: "session_info", id: "title-1", name: "Session" }];
    const before = forwardedSnapshot("owner", authorizationBranchIds(base), { policy: "inspect" }, base, builtinRead);
    const afterEntries = [
      ...base,
      { type: "custom", id: "note-1" },
      { type: "message", id: "call-1", message: { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "README.md" } }] } },
      { type: "message", id: "res-1", message: { role: "toolResult", toolCallId: "r1", toolName: "read", content: "ok" } },
    ];
    const after = forwardedSnapshot("owner", authorizationBranchIds(afterEntries), { policy: "inspect" }, afterEntries, builtinRead);
    expect(forwardedTransition(before, after)).toEqual({ kind: "stable-progress" });
  });

  const callEntry = (id: string, callId: string, name: string) => ({
    type: "message", id,
    message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: { path: "/p" } }] },
  });
  const resultEntry = (id: string, callId: string, name: string) => ({
    type: "message", id,
    message: { role: "toolResult", toolCallId: callId, toolName: name, content: "ok" },
  });
  const transitionAfterAppending = (base: readonly { type?: string; id?: unknown }[], appended: readonly { type?: string; id?: unknown }[]) => {
    const afterEntries = [...base, ...appended];
    const before = forwardedSnapshot("owner", authorizationBranchIds(base), { policy: "inspect" }, base, builtinRead);
    const after = forwardedSnapshot("owner", authorizationBranchIds(afterEntries), { policy: "inspect" }, afterEntries, builtinRead);
    return forwardedTransition(before, after);
  };

  it("treats a lone appended builtin call without a result as a review change, not progress", () => {
    const base = [entry("user", "user", "Inspect.")];
    expect(transitionAfterAppending(base, [callEntry("call-1", "r1", "read")])).toEqual({ kind: "review-changed" });
  });

  it("treats a partially completed appended builtin batch as a review change", () => {
    const base = [entry("user", "user", "Inspect.")];
    const appended = [
      callEntry("call-1", "r1", "read"),
      callEntry("call-2", "r2", "grep"),
      resultEntry("res-1", "r1", "read"),
    ];
    const sources = [...builtinRead, { name: "grep", sourceInfo: { source: "builtin", path: "<builtin:grep>" } }];
    const afterEntries = [...base, ...appended];
    const before = forwardedSnapshot("owner", authorizationBranchIds(base), { policy: "inspect" }, base, sources);
    const after = forwardedSnapshot("owner", authorizationBranchIds(afterEntries), { policy: "inspect" }, afterEntries, sources);
    expect(forwardedTransition(before, after)).toEqual({ kind: "review-changed" });
  });

  it("keeps fully paired appended builtin calls as stable progress", () => {
    const base = [entry("user", "user", "Inspect.")];
    expect(transitionAfterAppending(base, [
      callEntry("call-1", "r1", "read"),
      resultEntry("res-1", "r1", "read"),
      callEntry("call-2", "r2", "read"),
      resultEntry("res-2", "r2", "read"),
    ])).toEqual({ kind: "stable-progress" });
  });

  it("does not let a baseline outstanding non-builtin call block appended completed builtin pairs", () => {
    const base = [
      entry("user", "user", "Inspect."),
      callEntry("agent-call", "a1", "Agent"),
    ];
    expect(transitionAfterAppending(base, [
      callEntry("call-1", "r1", "read"),
      resultEntry("res-1", "r1", "read"),
    ])).toEqual({ kind: "stable-progress" });
  });

  it("still rejects duplicate appended call ids and wrong result names", () => {
    const base = [entry("user", "user", "Inspect.")];
    expect(transitionAfterAppending(base, [
      callEntry("call-1", "r1", "read"),
      callEntry("call-2", "r1", "read"),
      resultEntry("res-1", "r1", "read"),
    ])).toEqual({ kind: "review-changed" });
    expect(transitionAfterAppending(base, [
      callEntry("call-1", "r1", "read"),
      resultEntry("res-1", "r1", "grep"),
    ])).toEqual({ kind: "review-changed" });
  });

  it("requires an active direct parent registration and live tintin run for requester liveness", () => {
    const registry = new SubagentSessionRegistry();
    const details = { forwarding: { requesterAgentName: "worker", requesterSessionId: "child-1" } } as PromptPermissionDetails;
    registry.startTintinRun({ agentId: "abcdefgh-1234", parentSessionId: "owner" });
    registry.register("child-1", { parentSessionId: "owner", tintinAgentId: "abcdefgh-1234" });
    expect(forwardedRequesterIsCurrent(registry, details, "owner")).toBe(true);
    expect(forwardedRequesterIsCurrent(registry, details, "other-owner")).toBe(false);
    registry.register("child-1", { parentSessionId: "owner", tintinAgentId: "abcdefgh-1234", experimentalNestedForwarding: true });
    expect(forwardedRequesterIsCurrent(registry, details, "owner")).toBe(false);
    registry.register("child-1", { parentSessionId: "owner", tintinAgentId: "abcdefgh-1234" });
    registry.finishTintinRun("abcdefgh-1234", "owner");
    expect(forwardedRequesterIsCurrent(registry, details, "owner")).toBe(false);
  });
});

describe("forwarded review guards", () => {
  it("a missing bound guard satisfies only the unbound evaluation", () => {
    const details = {
      requestId: "req-guard",
      forwarding: { requesterAgentName: "worker", requesterSessionId: "child-1" },
    } as PromptPermissionDetails;
    expect(forwardedReviewIsCurrent(details)).toBe(true);
    expect(forwardedReviewIsCurrent(details, true)).toBe(false);
  });

  it("invokes a bound guard under requireBound and fails closed on false", () => {
    const details = {
      requestId: "req-bound",
      forwarding: { requesterAgentName: "worker", requesterSessionId: "child-1" },
    } as PromptPermissionDetails;
    let current = false;
    bindForwardedReview(details, () => current);
    expect(forwardedReviewIsCurrent(details, true)).toBe(false);
    current = true;
    expect(forwardedReviewIsCurrent(details, true)).toBe(true);
  });
});
