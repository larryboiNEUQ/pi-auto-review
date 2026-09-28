/** Whether an ask's tool call was the only call in its assistant batch. */
export type ToolBatchProvenance = "single" | "multiple" | "unknown";

export function isToolBatchProvenance(value: unknown): value is ToolBatchProvenance {
  return value === "single" || value === "multiple" || value === "unknown";
}

/** Pi persists the assistant message before preparing its tool-call batch. Its
 * parallel dispatcher waits for every ask before executing any prepared call.
 * A missing matching host message is NOT proof of a single-call batch. */
export function toolBatchProvenance(entries: readonly unknown[], toolCallId: string): ToolBatchProvenance {
  // A tool-call ID can be reused across turns. Only the current assistant
  // message, with no newer user/result/assistant turn, can attest this batch.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const wrapper = entry as { type?: unknown; message?: unknown; role?: unknown; content?: unknown };
    const message = wrapper.type === "message" ? wrapper.message : wrapper.type === undefined ? wrapper : undefined;
    if (!message || typeof message !== "object") continue;
    const assistant = message as { role?: unknown; content?: unknown };
    if (assistant.role === "user" || assistant.role === "toolResult" || assistant.role === "tool") return "unknown";
    if (assistant.role !== "assistant") continue;
    if (!Array.isArray(assistant.content)) return "unknown";
    const calls = assistant.content.filter((part: unknown): part is { type: "toolCall"; id?: unknown } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
    if (!calls.length) return "unknown";
    if (!calls.some((call) => call.id === toolCallId)) return "unknown";
    return calls.length === 1 ? "single" : "multiple";
  }
  return "unknown";
}
