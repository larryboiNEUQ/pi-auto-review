import { describe, expect, it } from "vitest";

import { buildApprovalDossier, selectEvidence } from "#safe/dossier";
import { makeDetails, makeFacts } from "#test/fixtures";

describe("approval dossier", () => {
  it("includes exact policy/action facts, secret-safe evidence, and no sandbox claim", () => {
    const dossier = buildApprovalDossier({
      details: makeDetails(),
      evidence: [
        { role: "user", content: "Inspect the repo using sk-abcdefghijklmnop" },
        { role: "assistant", content: [{ type: "text", text: "I will run git status." }] },
      ],
    });

    expect(dossier).toMatchObject({
      schemaVersion: 1,
      action: { exactActionId: "action-1", policy: { state: "ask" } },
      evidence: [
        { role: "user", text: "Inspect the repo using [REDACTED_SECRET]" },
        { role: "assistant", text: "I will run git status." },
      ],
      limitations: { osSandboxPresent: false },
    });
  });

  it("fails closed when exact action facts are incomplete", () => {
    const dossier = buildApprovalDossier({
      details: makeDetails(makeFacts({ complete: false, missing: ["value"] })),
      evidence: [],
    });
    expect(dossier).toBeNull();
  });

  it("budgets tool calls separately so they cannot crowd out user intent", () => {
    const evidence = selectEvidence([
      { role: "user", content: "Keep the user intent visible." },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "x".repeat(20_000) },
          },
        ],
      },
    ]);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "user",
          role: "user",
          text: "Keep the user intent visible.",
          truncated: false,
        }),
        expect.objectContaining({
          category: "tool_call",
          role: "assistant",
          text: expect.stringContaining('"name":"bash"'),
          truncated: true,
        }),
      ]),
    );
  });

  it("redacts credential-shaped tool-call fields before serializing them", () => {
    const evidence = selectEvidence([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "fetch",
            arguments: { apiKey: "ordinary-secret-value" },
          },
        ],
      },
    ]);

    expect(evidence).toEqual([
      {
        category: "tool_call",
        role: "assistant",
        text: '{"name":"fetch","arguments":{"apiKey":"[REDACTED_SECRET]"}}',
        truncated: false,
      },
    ]);
  });

  it("excludes tool results by default and redacts them when enabled", () => {
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "token sk-abcdefghijklmnop" }],
      isError: false,
    };

    expect(selectEvidence([toolResult])).toEqual([]);
    expect(
      selectEvidence([toolResult], { includeToolResults: true }),
    ).toEqual([
      {
        category: "tool_result",
        role: "tool",
        text: "read result: token [REDACTED_SECRET]",
        truncated: false,
      },
    ]);
  });

  it("marks transcript truncation explicitly", () => {
    const evidence = selectEvidence([{ role: "user", content: "x".repeat(13_000) }]);
    expect(evidence).toEqual([
      {
        category: "user",
        role: "user",
        text: "x".repeat(12_000),
        truncated: true,
      },
    ]);
  });
});
