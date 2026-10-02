/**
 * Host entries that cannot grant or revoke authorization. Pi and other
 * extensions append these while a tool call is waiting (session title,
 * bookmarks, model/thinking metadata). They must not invalidate an in-flight
 * review. Message, compaction, and any unrecognized entry stay in the identity
 * so a real branch change still fails closed.
 */
const NON_AUTHORIZING_BRANCH_TYPES = new Set([
  "session_info",
  "custom",
  "label",
  "model_change",
  "thinking_level_change",
]);

export function authorizationBranchIds(
  branch: readonly { type?: string; id?: unknown }[] | undefined,
): string[] | undefined {
  if (!branch) return undefined;
  const ids: string[] = [];
  for (const entry of branch) {
    if (typeof entry.type === "string" && NON_AUTHORIZING_BRANCH_TYPES.has(entry.type)) continue;
    if (typeof entry.id !== "string") return undefined;
    ids.push(entry.id);
  }
  return ids;
}
