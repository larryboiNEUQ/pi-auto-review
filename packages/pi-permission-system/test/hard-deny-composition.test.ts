import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalConfigPath, getProjectConfigPath } from "#src/config-paths";
import piPermissionSystemExtension from "#src/index";
import { getPermissionsService } from "#src/service";
import { makeFakePi } from "#test/helpers/make-fake-pi";
import { resetPermissionSystemGlobals } from "#test/helpers/reset-permission-system-globals";

let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-perm-hard-deny-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-perm-hard-deny-cwd-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  resetPermissionSystemGlobals();
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeConfig(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function evaluateToolCall(options: {
  path?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  trusted?: boolean;
}): Promise<{
  result: { block?: true; reason?: string };
  safeAllow: ReturnType<typeof vi.fn>;
}> {
  const toolName = options.toolName ?? "read";
  const pi = makeFakePi({ toolNames: [toolName] });
  piPermissionSystemExtension(pi as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => options.trusted ?? false,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "hard-deny-composition-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (): Promise<string> => "Yes",
      input: async (): Promise<undefined> => undefined,
    },
  };
  await pi.fire("session_start", { reason: "start" }, ctx);

  const safeAllow = vi.fn(() =>
    Promise.resolve({ kind: "deny" as const, reason: "reviewed ask" }),
  );
  getPermissionsService()!.registerAuthorizer("safe-allow", safeAllow);

  const input = options.input ?? { path: options.path };
  const result = (await pi.fire(
    "tool_call",
    { toolName, toolCallId: "hard-deny-call", input },
    ctx,
  )) as { block?: true; reason?: string };
  return { result, safeAllow };
}

const companySecretsRule = {
  surface: "path",
  pattern: "*/finance/private/*",
  code: "HARD_DENY_COMPANY_SECRET",
  reason: "company finance secrets are restricted",
};

const projectOnlyRule = {
  surface: "path",
  pattern: "*/project-only/*",
  code: "HARD_DENY_PROJECT_ONLY",
  reason: "project-specific restriction",
};

describe("Issue #15 hard-deny composition and project trust", () => {
  it("routes an operator-added path rule to deterministic deny without entering safe-allow", async () => {
    writeConfig(getGlobalConfigPath(agentDir), {
      hardDeny: ["$defaults", companySecretsRule],
      authorizerChain: ["safe-allow"],
      permission: { "*": "allow", path: "allow", read: "allow" },
    });

    const { result, safeAllow } = await evaluateToolCall({
      path: join(cwd, "finance", "private", "forecast.csv"),
    });

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("HARD_DENY_COMPANY_SECRET"),
    });
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("retains the built-in baseline when the global operator includes $defaults", async () => {
    writeConfig(getGlobalConfigPath(agentDir), {
      hardDeny: ["$defaults", companySecretsRule],
      authorizerChain: ["safe-allow"],
      permission: { "*": "allow", path: "allow", read: "allow" },
    });

    const { result, safeAllow } = await evaluateToolCall({
      path: join(cwd, ".env"),
    });

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("HARD_DENY_SECRET_PATH"),
    });
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("does not let an untrusted project replace the global hard-deny baseline", async () => {
    writeConfig(getGlobalConfigPath(agentDir), {
      hardDeny: ["$defaults", companySecretsRule],
      authorizerChain: ["safe-allow"],
      permission: { "*": "allow", path: "allow", read: "allow" },
    });
    writeConfig(getProjectConfigPath(cwd), {
      hardDeny: [projectOnlyRule],
    });

    const { result, safeAllow } = await evaluateToolCall({
      path: join(cwd, "finance", "private", "forecast.csv"),
      trusted: false,
    });

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("HARD_DENY_COMPANY_SECRET"),
    });
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("ignores an untrusted project deny and escalates an ask to safe-allow", async () => {
    writeConfig(getGlobalConfigPath(agentDir), {
      hardDeny: ["$defaults", companySecretsRule],
      authorizerChain: ["safe-allow"],
      permission: { "*": "ask", path: "ask", read: "ask" },
    });
    writeConfig(getProjectConfigPath(cwd), {
      hardDeny: [projectOnlyRule],
    });

    const { result, safeAllow } = await evaluateToolCall({
      path: join(cwd, "project-only", "policy.txt"),
      trusted: false,
    });

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("reviewed ask"),
    });
    expect(safeAllow).toHaveBeenCalledTimes(1);
  });

  it("lets a trusted project add a stricter hard deny without entering safe-allow", async () => {
    writeConfig(getGlobalConfigPath(agentDir), {
      hardDeny: ["$defaults", companySecretsRule],
      authorizerChain: ["safe-allow"],
      permission: { "*": "allow", path: "allow", read: "allow" },
    });
    writeConfig(getProjectConfigPath(cwd), {
      hardDeny: [projectOnlyRule],
    });

    const { result, safeAllow } = await evaluateToolCall({
      path: join(cwd, "project-only", "policy.txt"),
      trusted: true,
    });

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("HARD_DENY_PROJECT_ONLY"),
    });
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("keeps global shell alias enforcement when a project redefines the alias", async () => {
    writeConfig(getGlobalConfigPath(agentDir), {
      hardDeny: [
        "$defaults",
        {
          surface: "bash",
          pattern: "terraform destroy *",
          code: "HARD_DENY_TERRAFORM_DESTROY",
          reason: "destructive infrastructure changes are restricted",
        },
      ],
      shellTools: {
        exec_command: { commandArgument: "cmd" },
      },
      authorizerChain: ["safe-allow"],
      permission: { "*": "allow", bash: "allow" },
    });
    writeConfig(getProjectConfigPath(cwd), {
      shellTools: {
        exec_command: { commandArgument: "ignored" },
      },
    });

    const { result, safeAllow } = await evaluateToolCall({
      toolName: "exec_command",
      input: { cmd: "terraform destroy production", ignored: "echo safe" },
      trusted: false,
    });

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("HARD_DENY_TERRAFORM_DESTROY"),
    });
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("replaces built-in defaults only when the global operator omits $defaults", async () => {
    writeConfig(getGlobalConfigPath(agentDir), {
      hardDeny: [companySecretsRule],
      authorizerChain: ["safe-allow"],
      permission: { "*": "allow", path: "allow", read: "allow" },
    });

    const { result, safeAllow } = await evaluateToolCall({
      path: join(cwd, ".env"),
    });

    expect(result.block).toBeUndefined();
    expect(safeAllow).not.toHaveBeenCalled();
  });
});
