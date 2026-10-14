import { createHash } from "node:crypto";

import { authorizationBranchIds } from "./authorization-branch";
import { authorizationSnapshot, authorizationTransition, type AuthorizationSnapshot } from "./authorization-receipt";
import type { PromptPermissionDetails } from "./permission-prompter";
import type { SubagentSessionRegistry } from "./subagent-registry";

export interface ToolSource {
  name: string;
  sourceInfo?: { source?: string; path?: string };
}

export type ToolSourcesReader = () => readonly ToolSource[] | undefined;

type Activity =
  | { kind: "narrative"; calls: readonly { id: string; name: string }[] }
  | { kind: "result"; id: string; name: string }
  | { kind: "unknown" };

export interface ForwardedSnapshot {
  authority: AuthorizationSnapshot;
  activities: readonly Activity[];
  builtinSources: ReadonlyMap<string, string> | undefined;
}

export type ForwardedTransition =
  | { kind: "unchanged" | "stable-progress" }
  | { kind: "review-changed" }
  | { kind: "hard"; dimension: "owner" | "config" | "history" | "branch" };

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const readTools = new Set(["read", "grep", "find", "ls"]);

function activity(entry: unknown): Activity {
  const value = entry as { type?: string; message?: { role?: string; content?: unknown; toolCallId?: unknown; toolName?: unknown; source?: unknown } } | null;
  const message = value?.message;
  if (value?.type !== "message" || !message || message.source !== undefined) return { kind: "unknown" };
  if (message.role === "toolResult") {
    return typeof message.toolCallId === "string" && message.toolCallId.length > 0 && typeof message.toolName === "string"
      ? { kind: "result", id: message.toolCallId, name: message.toolName } : { kind: "unknown" };
  }
  if (message.role !== "assistant") return { kind: "unknown" };
  if (typeof message.content === "string") return { kind: "narrative", calls: [] };
  if (!Array.isArray(message.content)) return { kind: "unknown" };
  const calls: { id: string; name: string }[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") return { kind: "unknown" };
    if (part.type === "text" && typeof part.text === "string") continue;
    if (part.type === "thinking" && typeof part.thinking === "string") continue;
    if (part.type !== "toolCall" || typeof part.id !== "string" || !part.id || typeof part.name !== "string") return { kind: "unknown" };
    calls.push({ id: part.id, name: part.name });
  }
  return { kind: "narrative", calls };
}

export function forwardedSnapshot(
  owner: string | undefined,
  branchIds: readonly string[] | undefined,
  config: unknown,
  entries: readonly unknown[],
  sources: readonly ToolSource[] | undefined,
): ForwardedSnapshot {
  const relevant = entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    return authorizationBranchIds([entry as { type?: string; id?: unknown }])?.length !== 0;
  });
  const expected = authorizationBranchIds(relevant as { type?: string; id?: unknown }[]);
  const provenIds = branchIds && expected && digest(branchIds) === digest(expected) && expected.every((id) => id.length > 0)
    ? expected : undefined;
  const builtinSources = sources && new Map<string, string>();
  for (const name of readTools) {
    const matches = sources?.filter((tool) => tool.name === name);
    const source = matches?.length === 1 ? matches[0]?.sourceInfo : undefined;
    if (source?.source === "builtin" && source.path === `<builtin:${name}>`) builtinSources?.set(name, digest(source));
  }
  return {
    authority: authorizationSnapshot(owner, provenIds, config, relevant),
    activities: relevant.map(activity),
    builtinSources,
  };
}

export function forwardedTransition(before: ForwardedSnapshot, after: ForwardedSnapshot): ForwardedTransition {
  const transition = authorizationTransition(before.authority, after.authority);
  if (transition.kind === "hard" || transition.kind === "unchanged") return transition;
  if (!before.builtinSources || !after.builtinSources) return { kind: "review-changed" };
  const native = (name: string): boolean => before.builtinSources!.has(name) &&
    before.builtinSources!.get(name) === after.builtinSources!.get(name);
  const calls = new Map<string, { name: string; completed: boolean; appended: boolean }>();
  for (let i = 0; i < after.activities.length; i++) {
    const current = after.activities[i]!;
    const appended = i >= before.activities.length;
    if (current.kind === "unknown") {
      if (appended) return { kind: "review-changed" };
    } else if (current.kind === "narrative") {
      for (const call of current.calls) {
        if (calls.has(call.id) || (appended && !native(call.name))) return { kind: "review-changed" };
        calls.set(call.id, { name: call.name, completed: false, appended });
      }
    } else {
      const call = calls.get(current.id);
      if (appended && (!call || call.completed || call.name !== current.name || !native(call.name))) return { kind: "review-changed" };
      if (call) call.completed = true;
    }
  }
  for (const call of calls.values()) {
    if (call.appended && !call.completed) return { kind: "review-changed" };
  }
  return { kind: "stable-progress" };
}

export function forwardedBinding(details: PromptPermissionDetails, owner: string | undefined): string {
  return digest([owner, details.requestId, details.delegatedApproval, details.accessIntent, details.agentName,
    details.forwarding, details.forwardedBatchProvenance, details.forwardedHostVersion]);
}

export function forwardedRequesterIsCurrent(
  registry: SubagentSessionRegistry | undefined,
  details: PromptPermissionDetails,
  owner: string | undefined,
): boolean {
  const requester = details.forwarding?.requesterSessionId;
  const child = requester && registry?.get(requester);
  return !!owner && !!child && child.parentSessionId === owner && !child.experimentalNestedForwarding &&
    (!child.tintinAgentId || !!registry?.hasActiveTintinRun(child.tintinAgentId));
}

const reviewGuards = new WeakMap<object, () => boolean>();

export function bindForwardedReview(details: PromptPermissionDetails, isCurrent: () => boolean): void {
  reviewGuards.set(details, isCurrent);
}

export function forwardedReviewIsCurrent(
  details: PromptPermissionDetails,
  requireBound = false,
): boolean {
  return reviewGuards.get(details)?.() ?? !requireBound;
}
