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

describe("toolBatchProvenance", () => {
  it("proves a single call only from the latest assistant message", () => {
    expect(toolBatchProvenance([user, assistant("tc-1")], "tc-1")).toBe("single");
    expect(toolBatchProvenance([user, assistant("tc-1", "tc-2")], "tc-1")).toBe("multiple");
  });

  it("does not borrow a reused ID from an older turn", () => {
    expect(toolBatchProvenance([assistant("tc-1"), assistant("other")], "tc-1")).toBe("unknown");
    expect(toolBatchProvenance([assistant("tc-1"), user], "tc-1")).toBe("unknown");
    expect(toolBatchProvenance([], "tc-1")).toBe("unknown");
  });
});
