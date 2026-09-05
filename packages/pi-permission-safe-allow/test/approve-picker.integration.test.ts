import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  APPROVAL_OPTION_MAX_COLUMNS,
  buildApprovalPickerOptions,
  displayColumns,
} from "#safe/approval-picker";
import { DenialLifecycle } from "#safe/denial-lifecycle";
import type { ApprovalDossier } from "#safe/dossier";
import { createSafeAllowExtension } from "#safe/extension";
import { makeFacts } from "#test/fixtures";

function record(
  lifecycle: DenialLifecycle,
  inputs: {
    id: string;
    exact: string;
    command?: string;
    rationale?: string;
    risk?: "low" | "medium" | "high" | "critical";
    facts?: ReturnType<typeof makeFacts>;
    now?: number;
  },
) {
  const facts = inputs.facts ?? makeFacts({
    requestId: inputs.id,
    exactActionId: inputs.exact,
    value: inputs.command ?? "git status",
    action: {
      ...makeFacts().action,
      command: inputs.command ?? "git status",
      input: { command: inputs.command ?? "git status" },
    },
  });
  return lifecycle.recordDenial({
    dossier: {
      request: { id: inputs.id, source: "tool_call", agentName: null },
      action: facts,
    } as ApprovalDossier,
    rationale: inputs.rationale ?? "The action modifies a remote repository.",
    riskLevel: inputs.risk ?? "high",
    now: inputs.now ?? 1_700_000_000_000,
  }).record;
}

function commandHarness(lifecycle: DenialLifecycle) {
  let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const complete = vi.fn();
  const pi = {
    on: vi.fn(),
    events: { on: vi.fn() },
    registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
      handler = definition.handler;
    }),
  } as unknown as ExtensionAPI;
  createSafeAllowExtension(pi, { lifecycle, complete });
  const notify = vi.fn();
  const select = vi.fn();
  const ctx = {
    cwd: "/Users/operator/projects/very-long-project-name",
    ui: { notify, select },
  } as unknown as ExtensionContext;
  return { run: (args = "") => handler!(args, ctx), notify, select, complete };
}

describe("/approve picker integration", () => {
  it("renders a bounded, risk-first, secret-safe shell-chain option without IDs", () => {
    const lifecycle = new DenialLifecycle();
    const cwd = "/Users/operator/projects/very-long-project-name";
    const denial = record(lifecycle, {
      id: "call_abcdefghijklmnopqrstuvwxyz0123456789",
      exact: "sha256-exact-action-id-that-must-not-be-visible",
      now: 1_735_689_600_000,
      command: `cd ${cwd} && npm test && git add packages/pi-permission-safe-allow && git commit -m "fix picker" && git push origin impl/issue-29 && gh run watch --exit-status`,
      rationale: "Denied because token=super-secret-value\n\u001b[31mremote mutation needs explicit approval. This sentence is intentionally much too long to display in full.",
    });

    const [option] = buildApprovalPickerOptions([denial], cwd);
    expect(option!.label).toMatch(/^#1 \[HIGH\] Shell — /);
    expect(option!.label).toContain("git push");
    expect(option!.label).toMatch(/\(\+\d+ steps\)/);
    expect(option!.label).toContain("[SECRET]");
    expect(option!.label).not.toContain("super-secret-value");
    expect(option!.label).not.toContain("call_abcdefghijklmnopqrstuvwxyz");
    expect(option!.label).not.toContain("1735689600000");
    expect(option!.label).not.toContain("\u001b");
    expect(option!.label).not.toContain("[31m");
    expect(displayColumns(option!.label)).toBeLessThanOrEqual(APPROVAL_OPTION_MAX_COLUMNS);
  });

  it("keeps uncertain shell text honest and formats typed action surfaces", () => {
    const lifecycle = new DenialLifecycle();
    const shell = record(lifecycle, {
      id: "shell",
      exact: "shell",
      command: "bash -c '$RUNTIME_PAYLOAD && git push origin main",
    });
    const file = record(lifecycle, {
      id: "file",
      exact: "file",
      facts: makeFacts({
        surface: "write",
        value: "/repo/packages/feature/src/very-long-distinguishing-file.ts",
        exactActionId: "file",
        cwd: "/repo",
        action: { ...makeFacts().action, kind: "file", command: null, path: "/repo/packages/feature/src/very-long-distinguishing-file.ts", target: null },
      }),
    });
    const mcp = record(lifecycle, {
      id: "mcp",
      exact: "mcp",
      facts: makeFacts({
        surface: "mcp", value: "call", exactActionId: "mcp",
        action: { ...makeFacts().action, kind: "mcp", command: null, target: null, mcp: { server: "github", tool: "create_pull_request", annotations: null, connectedAccount: null, arguments: {} } },
      }),
    });
    const network = record(lifecycle, {
      id: "network",
      exact: "network",
      facts: makeFacts({ surface: "network", value: "https://api.example.com/private?q=secret", exactActionId: "network", action: { ...makeFacts().action, kind: "network", command: null, target: "https://api.example.com/private?q=secret" } }),
    });
    const labels = buildApprovalPickerOptions([shell, file, mcp, network], "/repo").map((item) => item.label);
    expect(labels[0]).toContain("bash -c");
    expect(labels[0]).not.toContain("(+");
    expect(labels[1]).toContain("./packages/feature/src/very-long-distinguishing-file.ts");
    expect(labels[2]).toContain("github/create_pull_request");
    expect(labels[3]).toContain("api.example.com");
  });

  it("maps duplicate-looking individual labels to the selected denial", async () => {
    const lifecycle = new DenialLifecycle();
    record(lifecycle, { id: "older", exact: "action-a", command: "git push origin alpha", now: 1 });
    record(lifecycle, { id: "newer", exact: "action-b", command: "git push origin beta", now: 2 });
    const harness = commandHarness(lifecycle);
    harness.select.mockImplementation(async (_title: string, labels: string[]) => labels[1]);

    await harness.run();

    expect(lifecycle.consumeOverride("action-a")).not.toBeNull();
    expect(lifecycle.consumeOverride("action-b")).toBeNull();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("still be reviewed"), "info");
  });

  it("bulk-authorizes one one-shot retry per unique shown action", async () => {
    const lifecycle = new DenialLifecycle();
    record(lifecycle, { id: "outside", exact: "outside", now: 0 });
    // Fill past the bounded ten-record history so "outside" is no longer shown.
    for (let index = 0; index < 8; index++) record(lifecycle, { id: `filler-${index}`, exact: `filler-${index}`, now: index + 1 });
    record(lifecycle, { id: "duplicate-old", exact: "shared", command: "git push origin main", now: 20 });
    record(lifecycle, { id: "duplicate-new", exact: "shared", command: "git push origin main", now: 21 });
    record(lifecycle, { id: "second", exact: "second", command: "npm publish", now: 22 });
    const harness = commandHarness(lifecycle);
    harness.select.mockImplementation(async (_title: string, labels: string[]) => labels.at(-1));

    await harness.run();

    const shownUnique = new Set(lifecycle.recentDenials().map((item) => item.exactActionId));
    expect(harness.select.mock.calls[0]![1].at(-1)).toBe(`──────── Approve all shown (${shownUnique.size} exact retries)`);
    expect(lifecycle.consumeOverride("shared")).not.toBeNull();
    expect(lifecycle.consumeOverride("shared")).toBeNull();
    expect(lifecycle.consumeOverride("second")).not.toBeNull();
    expect(lifecycle.consumeOverride("outside")).toBeNull();
    expect(lifecycle.consumeOverride("altered-command")).toBeNull();
    expect(harness.notify).toHaveBeenCalledWith(`${shownUnique.size} exact retries are authorized. Ask the agent to retry each action; every retry will still be reviewed and absolute denies still apply.`, "info");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("omits bulk for one unique action and preserves cancellation and direct IDs", async () => {
    const lifecycle = new DenialLifecycle();
    const denial = record(lifecycle, { id: "direct", exact: "only" });
    const harness = commandHarness(lifecycle);
    harness.select.mockResolvedValue(undefined);
    await harness.run();
    expect(harness.select.mock.calls[0]![1]).toHaveLength(1);
    expect(lifecycle.consumeOverride("only")).toBeNull();

    await harness.run("stale-id");
    expect(lifecycle.consumeOverride("only")).toBeNull();
    await harness.run(denial.denialId);
    expect(lifecycle.consumeOverride("only")).not.toBeNull();
  });

  it("reports an empty history without opening the picker", async () => {
    const harness = commandHarness(new DenialLifecycle());
    await harness.run();
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(
      "There are no recent delegated-review denials.",
      "info",
    );
  });

  it("rejects an invalid atomic batch without creating partial overrides", () => {
    const lifecycle = new DenialLifecycle();
    const denial = record(lifecycle, { id: "valid", exact: "valid" });
    expect(lifecycle.authorizeRetries([denial.denialId, "stale"])).toBeNull();
    expect(lifecycle.consumeOverride("valid")).toBeNull();
  });
});
