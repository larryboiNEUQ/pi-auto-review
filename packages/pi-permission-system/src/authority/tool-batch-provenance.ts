/** Whether an ask's tool call was the only call in its assistant batch. */
export type ToolBatchProvenance = "single" | "multiple" | "unknown";

export function isToolBatchProvenance(value: unknown): value is ToolBatchProvenance {
  return value === "single" || value === "multiple" || value === "unknown";
}

/** Pi persists the assistant message before preparing its tool-call batch.
 * Sequential dispatch may already have recorded a completed prefix of that batch.
 * A missing matching host message is NOT proof of a single-call batch. */
export function toolBatchProvenance(entries: readonly unknown[], toolCallId: string): ToolBatchProvenance {
  // IDs can be reused across turns. Only the latest assistant message may
  // attest pending calls; intervening results must be its completed prefix.
  const results: { toolCallId: string; toolName?: unknown }[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const wrapper = entry as { type?: unknown; message?: unknown; role?: unknown; content?: unknown };
    const message = wrapper.type === "message" ? wrapper.message : wrapper.type === undefined ? wrapper : undefined;
    if (!message || typeof message !== "object") continue;
    const hostMessage = message as { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown };
    if (hostMessage.role === "user" || hostMessage.role === "tool") return "unknown";
    if (hostMessage.role === "toolResult") {
      if (typeof hostMessage.toolCallId !== "string" || !hostMessage.toolCallId) return "unknown";
      results.push({ toolCallId: hostMessage.toolCallId, toolName: hostMessage.toolName });
      continue;
    }
    if (hostMessage.role !== "assistant") continue;
    if (!Array.isArray(hostMessage.content)) return "unknown";
    const calls = hostMessage.content.filter((part: unknown): part is { type: "toolCall"; id?: unknown; name?: unknown } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
    if (!calls.length || calls.some((call) => typeof call.id !== "string" || !call.id)) return "unknown";
    if (new Set(calls.map((call) => call.id)).size !== calls.length) return "unknown";
    const requestedIndex = calls.findIndex((call) => call.id === toolCallId);
    if (requestedIndex < results.length || requestedIndex < 0 || results.length > calls.length) return "unknown";
    for (let completedIndex = 0; completedIndex < results.length; completedIndex++) {
      const result = results[results.length - 1 - completedIndex]!;
      const call = calls[completedIndex]!;
      if (result.toolCallId !== call.id || (result.toolName !== undefined && result.toolName !== call.name)) return "unknown";
    }
    return calls.length === 1 ? "single" : "multiple";
  }
  return "unknown";
}
