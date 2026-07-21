import { describe, expect, it } from "vitest";

import { buildDelegatedApprovalFacts } from "#src/authority/delegated-approval-facts";
import { makeCheckResult } from "#test/helpers/handler-fixtures";

describe("buildDelegatedApprovalFacts", () => {
  it("builds a stable shell action contract and redacts credential fields", () => {
    const build = () =>
      buildDelegatedApprovalFacts({
        details: {
          requestId: "req-1",
          source: "tool_call",
          agentName: null,
          message: "Allow command?",
          toolName: "bash",
          command: "curl -H 'Authorization: Bearer top-secret' https://example.test",
          cwd: "/work/repo",
        },
        input: {
          command: "curl --token plain-secret https://example.test",
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
          headers: { authorization: "Bearer top-secret" },
        },
        check: makeCheckResult({ state: "ask", source: "bash" }),
        surface: "bash",
        value: "curl https://example.test",
      });

    const first = build();
    const second = build();

    expect(first).toMatchObject({
      version: 1,
      surface: "bash",
      cwd: "/work/repo",
      complete: true,
      action: {
        kind: "shell",
        command:
          "curl -H 'Authorization: [REDACTED_SECRET]' https://example.test",
        authentication: {
          credentialPresent: true,
          valuesIncluded: false,
        },
        input: {
          apiKey: "[REDACTED_SECRET]",
          headers: { authorization: "[REDACTED_SECRET]" },
        },
      },
      permissionDelta: { from: "ask", to: "allow_once" },
    });
    expect(first.redactions).toEqual(
      expect.arrayContaining([
        "action.input.command",
        "action.input.apiKey",
        "action.input.headers.authorization",
        "action.command",
      ]),
    );
    expect(first.exactActionId).toBe(second.exactActionId);
    expect(JSON.stringify(first)).not.toContain("top-secret");
    expect(JSON.stringify(first)).not.toContain("plain-secret");
    expect(JSON.stringify(first)).not.toContain("sk-abcdefghijkl");
  });

  it("marks an action incomplete when its exact value is unavailable", () => {
    const facts = buildDelegatedApprovalFacts({
      details: {
        requestId: "req-2",
        source: "tool_call",
        agentName: null,
        message: "Allow special operation?",
      },
      input: {},
      check: makeCheckResult({ state: "ask" }),
      surface: "special",
      value: "",
    });

    expect(facts.complete).toBe(false);
    expect(facts.missing).toEqual(["value"]);
  });

  it("binds exact action identity to cwd and normalized access context", () => {
    const build = (cwd: string) =>
      buildDelegatedApprovalFacts({
        details: {
          requestId: "req-relative",
          source: "tool_call",
          agentName: null,
          message: "Delete build output?",
          toolName: "bash",
          command: "rm -rf build",
          cwd,
          accessIntent: {
            surface: "bash",
            matchValues: ["rm -rf build"],
            boundaryValue: null,
          },
        },
        input: { command: "rm -rf build" },
        check: makeCheckResult({ state: "ask", source: "bash" }),
        surface: "bash",
        value: "rm -rf build",
      });

    expect(build("/repo/a").exactActionId).not.toBe(
      build("/repo/b").exactActionId,
    );
  });

  it("fails closed for a genuinely unknown runtime shell payload", () => {
    const facts = buildDelegatedApprovalFacts({
      details: {
        requestId: "req-dynamic",
        source: "tool_call",
        agentName: null,
        message: "Run payload?",
        toolName: "bash",
        command: 'bash -c "$RUNTIME_PAYLOAD"',
      },
      input: { command: 'bash -c "$RUNTIME_PAYLOAD"' },
      check: makeCheckResult({ state: "ask", source: "bash" }),
      surface: "bash",
      value: 'bash -c "$RUNTIME_PAYLOAD"',
    });

    expect(facts.complete).toBe(false);
    expect(facts.missing).toContain("runtime_payload");
  });

  it("keeps MCP annotations, exact arguments, and connected account facts typed", () => {
    const facts = buildDelegatedApprovalFacts({
      details: {
        requestId: "req-mcp",
        source: "tool_call",
        agentName: null,
        message: "Create issue?",
        toolName: "mcp",
        target: "github:create_issue",
      },
      input: {
        server: "github",
        tool: "create_issue",
        annotations: { destructiveHint: false, readOnlyHint: false },
        connectedAccount: { id: "account-1" },
        arguments: { repo: "o/r", title: "Bug" },
      },
      check: makeCheckResult({ state: "ask", source: "mcp", target: "github:create_issue" }),
      surface: "mcp",
      value: "github:create_issue",
    });

    expect(facts.action.mcp).toEqual({
      server: "github",
      tool: "create_issue",
      annotations: { destructiveHint: false, readOnlyHint: false },
      connectedAccount: { id: "account-1" },
      arguments: { repo: "o/r", title: "Bug" },
    });
  });

  it.each([
    { cwd: "/Users/alice/repo", path: "/Users/alice/out/report.md" },
    { cwd: "C:\\Users\\alice\\repo", path: "C:\\Users\\alice\\out\\report.md" },
  ])("uses the same dossier contract for platform-native path facts ($cwd)", ({ cwd, path }) => {
    const facts = buildDelegatedApprovalFacts({
      details: {
        requestId: "req-path",
        source: "tool_call",
        agentName: null,
        message: "Write report?",
        toolName: "write",
        path,
        cwd,
      },
      input: { path, content: "report" },
      check: makeCheckResult({ state: "ask", source: "tool" }),
      surface: "write",
      value: path,
    });
    expect(facts).toMatchObject({
      version: 1,
      cwd,
      surface: "write",
      action: { kind: "file", path },
      permissionDelta: { from: "ask", to: "allow_once", surface: "write" },
      complete: true,
    });
  });
});
