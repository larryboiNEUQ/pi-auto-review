import { createHash } from "node:crypto";

import { authorizationBranchIds } from "./authorization-branch";

export interface AuthorizationSnapshot {
  ownerSessionId: string | undefined;
  branchIds: readonly string[] | undefined;
  configDigest: string;
  entries: readonly { id: string | undefined; digest: string; progress: boolean }[];
}

export type AuthorizationTransition =
  | { kind: "unchanged" }
  | { kind: "append-only" }
  | { kind: "hard"; dimension: "owner" | "config" | "history" | "branch" };

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

export function authorizationSnapshot(
  ownerSessionId: string | undefined,
  branchIds: readonly string[] | undefined,
  config: unknown,
  entries: readonly unknown[],
): AuthorizationSnapshot {
  const relevant = entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    return authorizationBranchIds([entry])?.length !== 0;
  });
  return {
    ownerSessionId,
    branchIds: branchIds && [...branchIds],
    configDigest: digest(config),
    entries: relevant.map((entry) => {
      const value = entry as { type?: string; id?: unknown; message?: { role?: string } } | null;
      return {
        id: typeof value?.id === "string" ? value.id : undefined,
        digest: digest(entry),
        progress: value?.type === "message" && (value.message?.role === "assistant" || value.message?.role === "toolResult"),
      };
    }),
  };
}

export function authorizationTransition(before: AuthorizationSnapshot, after: AuthorizationSnapshot): AuthorizationTransition {
  if (before.ownerSessionId !== after.ownerSessionId) return { kind: "hard", dimension: "owner" };
  if (before.configDigest !== after.configDigest) return { kind: "hard", dimension: "config" };
  if (after.entries.length < before.entries.length || before.entries.some((entry, i) => entry.digest !== after.entries[i]?.digest)) {
    return { kind: "hard", dimension: "history" };
  }
  if (digest(before.branchIds) === digest(after.branchIds) && before.entries.length === after.entries.length) return { kind: "unchanged" };
  const proven = (snapshot: AuthorizationSnapshot): boolean => !!snapshot.ownerSessionId && !!snapshot.branchIds &&
    snapshot.branchIds.length === snapshot.entries.length && new Set(snapshot.branchIds).size === snapshot.branchIds.length &&
    snapshot.entries.every((entry, i) => entry.id === snapshot.branchIds![i]);
  if (!proven(before) || !proven(after) || !before.branchIds!.every((id, i) => id === after.branchIds![i])) return { kind: "hard", dimension: "branch" };
  const appended = after.entries.slice(before.entries.length);
  return appended.length > 0 && appended.every((entry) => entry.progress)
    ? { kind: "append-only" }
    : { kind: "hard", dimension: "history" };
}

interface ApprovalReceipt {
  requestId: string;
  exactActionId: string;
  ownerSessionId: string;
  branchIds: readonly string[];
  deadline: number;
  isCurrent(): boolean;
  commit(): void;
  consumed?: boolean;
}

const receipts = new WeakMap<object, ApprovalReceipt>();

export function sealApproval(verdict: object, receipt: Omit<ApprovalReceipt, "consumed">): void {
  receipts.set(verdict, { ...receipt, branchIds: [...receipt.branchIds] });
}

export function transferApprovalReceipt(verdict: object, decision: object): void {
  const receipt = receipts.get(verdict);
  if (receipt) receipts.set(decision, receipt);
}

export function hasApprovalReceipt(decision: object): boolean {
  return receipts.has(decision);
}

export function consumeApprovalReceipt(
  decision: object,
  identity: { requestId: string; exactActionId: string | undefined; ownerSessionId: string; branchIds: readonly string[] | undefined },
  canRelease: boolean,
): boolean {
  const receipt = receipts.get(decision);
  if (!receipt || receipt.consumed) return false;
  receipt.consumed = true;
  try {
    if (!canRelease || receipt.requestId !== identity.requestId || receipt.exactActionId !== identity.exactActionId ||
        receipt.ownerSessionId !== identity.ownerSessionId || digest(receipt.branchIds) !== digest(identity.branchIds) ||
        Date.now() >= receipt.deadline || !receipt.isCurrent()) return false;
    receipt.commit();
    return true;
  } catch {
    return false;
  }
}
