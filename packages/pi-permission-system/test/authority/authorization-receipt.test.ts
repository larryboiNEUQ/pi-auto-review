import { describe, expect, it } from "vitest";

import { authorizationBranchIds } from "#src/authority/authorization-branch";
import { composeAuthorizerChain } from "#src/authority/authorizer-chain";
import {
  authorizationSnapshot, authorizationTransition, consumeApprovalReceipt,
  hasApprovalReceipt, sealApproval,
} from "#src/authority/authorization-receipt";
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
      expect(consumeApprovalReceipt(decision, identity, scenario !== "inactive")).toBe(scenario === "valid");
      expect(commits).toBe(scenario === "valid" ? 1 : 0);
      expect(consumeApprovalReceipt(decision, { requestId: "request", exactActionId: "action", ownerSessionId: "owner", branchIds: ["user"] }, true)).toBe(false);
      expect(commits).toBe(scenario === "valid" ? 1 : 0);
    },
  );
});
