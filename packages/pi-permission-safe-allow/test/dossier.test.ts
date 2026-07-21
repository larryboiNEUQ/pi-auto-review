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

  it("marks transcript truncation explicitly", () => {
    const evidence = selectEvidence([{ role: "user", content: "x".repeat(13_000) }]);
    expect(evidence).toEqual([
      { role: "user", text: "x".repeat(12_000), truncated: true },
    ]);
  });
});
