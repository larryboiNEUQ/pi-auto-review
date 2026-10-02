import { describe, expect, it } from "vitest";
import { toolBatchProvenance } from "#src/authority/tool-batch-provenance";

const user = { type: "message", message: { role: "user", content: "Inspect the repo." } };
const assistant = (...ids: string[]) => ({
  type: "message",
  message: {
    role: "assistant",
    content: ids.map((id) => ({ type: "toolCall", id, name: "bash" })),
  },
});

const toolResult = (toolCallId: unknown, toolName: unknown = "bash") => ({
  type: "message",
  message: { role: "toolResult", toolCallId, toolName, content: "completed" },
});

describe("toolBatchProvenance", () => {
  it("proves a single call only from the latest assistant message", () => {
    expect(toolBatchProvenance([user, assistant("tc-1")], "tc-1")).toBe("single");
    expect(toolBatchProvenance([user, assistant("tc-1", "tc-2")], "tc-1")).toBe("multiple");
  });

  it("keeps an uncompleted sibling in the current sequential batch", () => {
    const entries = [user, assistant("tc-1", "tc-2"), toolResult("tc-1")];
    expect(toolBatchProvenance(entries, "tc-2")).toBe("multiple");
    expect(toolBatchProvenance(entries, "tc-1")).toBe("unknown");
  });

  it("binds completed sequential prefixes without imposing the next call's order", () => {
    const batch = assistant("tc-1", "tc-2", "tc-3", "tc-4");
    expect(toolBatchProvenance([batch, toolResult("tc-1"), toolResult("tc-2")], "tc-3")).toBe("multiple");
    expect(toolBatchProvenance([batch, toolResult("tc-1")], "tc-4")).toBe("multiple");
    expect(toolBatchProvenance([batch, { type: "message", message: { role: "toolResult", toolCallId: "tc-1" } }], "tc-2")).toBe("multiple");
  });

  it.each([
    ["foreign result", [toolResult("other")]],
    ["missing result ID", [toolResult(undefined)]],
    ["empty result ID", [toolResult("")]],
    ["duplicate result", [toolResult("tc-1"), toolResult("tc-1")]],
    ["out-of-order result", [toolResult("tc-2")]],
    ["wrong tool name", [toolResult("tc-1", "write")]],
    ["new user message", [toolResult("tc-1"), user]],
    ["new assistant turn", [toolResult("tc-1"), assistant("other")]],
    ["generic tool output", [{ role: "tool", toolCallId: "tc-1", content: "done" }]],
  ])("does not accept %s as sequential batch proof", (_name, tail) => {
    expect(toolBatchProvenance([assistant("tc-1", "tc-2", "tc-3"), ...tail], "tc-3")).toBe("unknown");
  });

  it("rejects ambiguous call IDs and requests for completed calls", () => {
    expect(toolBatchProvenance([assistant("tc-1", "tc-1")], "tc-1")).toBe("unknown");
    expect(toolBatchProvenance([assistant("tc-1", "")], "tc-1")).toBe("unknown");
    expect(toolBatchProvenance([assistant("tc-1"), toolResult("tc-1")], "tc-1")).toBe("unknown");
    expect(toolBatchProvenance([assistant("tc-1", "tc-2"), toolResult("tc-1"), toolResult("tc-2")], "tc-2")).toBe("unknown");
    expect(toolBatchProvenance([assistant("tc-1", "tc-2"), toolResult("tc-1"), assistant("tc-3", "tc-4")], "tc-2")).toBe("unknown");
  });

  it("does not borrow a reused ID from an older turn", () => {
    expect(toolBatchProvenance([assistant("tc-1"), assistant("other")], "tc-1")).toBe("unknown");
    expect(toolBatchProvenance([assistant("tc-1"), user], "tc-1")).toBe("unknown");
    expect(toolBatchProvenance([], "tc-1")).toBe("unknown");
  });
});
