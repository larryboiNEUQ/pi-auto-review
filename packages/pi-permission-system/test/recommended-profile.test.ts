import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unifiedConfigSchema } from "#src/config-schema";
import { getGlobalConfigPath } from "#src/config-paths";
import piPermissionSystemExtension from "#src/index";
import { getPermissionsService } from "#src/service";
import { makeFakePi } from "#test/helpers/make-fake-pi";
import { resetPermissionSystemGlobals } from "#test/helpers/reset-permission-system-globals";

const PROFILE_PATH = join(
  import.meta.dirname,
  "..",
  "config",
  "codex-auto-v1.json",
);

function readRecommendedProfile(): unknown {
  return JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
}


let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-perm-profile-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-perm-profile-cwd-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

  const configPath = getGlobalConfigPath(agentDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(readRecommendedProfile(), null, 2)}\n`,
  );
});

afterEach(() => {
  resetPermissionSystemGlobals();
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function evaluateWithProfile(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{
  result: { block?: true; reason?: string };
  safeAllow: ReturnType<typeof vi.fn>;
}> {
  const pi = makeFakePi({ toolNames: [toolName] });
  piPermissionSystemExtension(pi as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "profile-session",
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

  const result = (await pi.fire(
    "tool_call",
    { toolName, toolCallId: `profile-${toolName}`, input },
    ctx,
  )) as { block?: true; reason?: string };
  return { result, safeAllow };
}

describe("Codex Auto v1 recommended profile", () => {
  it("ships as a schema-valid package artifact", () => {
    expect(unifiedConfigSchema.safeParse(readRecommendedProfile()).success).toBe(
      true,
    );
  });

  it("allows routine writes inside cwd without entering model review", async () => {
    const { result, safeAllow } = await evaluateWithProfile("write", {
      path: join(cwd, "src", "feature.ts"),
      content: "export {};",
    });

    expect(result.block).toBeUndefined();
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("allows a precise test-runner prefix without entering model review", async () => {
    const { result, safeAllow } = await evaluateWithProfile("bash", {
      command: "npm test -- --runInBand",
    });

    expect(result.block).toBeUndefined();
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("allows read-only git status without entering model review", async () => {
    const { result, safeAllow } = await evaluateWithProfile("bash", {
      command: "git status",
    });

    expect(result.block).toBeUndefined();
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("allows MCP discovery without entering model review", async () => {
    const { result, safeAllow } = await evaluateWithProfile("mcp", {});

    expect(result.block).toBeUndefined();
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("allows skill selection without entering model review", async () => {
    const { result, safeAllow } = await evaluateWithProfile("skill", {
      name: "code-review",
    });

    expect(result.block).toBeUndefined();
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("locally denies sensitive SSH paths without entering model review", async () => {
    const { result, safeAllow } = await evaluateWithProfile("read", {
      path: join(homedir(), ".ssh", "config"),
    });

    expect(result.block).toBe(true);
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it("denies sensitive SSH paths reached through bash without review", async () => {
    const { result, safeAllow } = await evaluateWithProfile("bash", {
      command: `cat ${join(homedir(), ".ssh", "config")}`,
    });

    expect(result.block).toBe(true);
    expect(safeAllow).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "external write",
      toolName: "write",
      input: (): Record<string, unknown> => ({
        path: join(cwd, "..", "outside", "file.ts"),
        content: "export {};",
      }),
    },
    {
      name: "network-capable bash",
      toolName: "bash",
      input: (): Record<string, unknown> => ({
        command: "curl https://example.com",
      }),
    },
    {
      name: "ambiguous destructive bash",
      toolName: "bash",
      input: (): Record<string, unknown> => ({ command: "git reset --hard HEAD" }),
    },
    {
      name: "destructive find",
      toolName: "bash",
      input: (): Record<string, unknown> => ({ command: "find . -delete" }),
    },
    {
      name: "side-effecting MCP call",
      toolName: "mcp",
      input: (): Record<string, unknown> => ({ tool: "github:create_issue" }),
    },
  ])("routes $name to model review", async ({ toolName, input }) => {
    const { result, safeAllow } = await evaluateWithProfile(toolName, input());

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("reviewed ask"),
    });
    expect(safeAllow).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "environment secret",
      toolName: "read",
      input: (): Record<string, unknown> => ({ path: join(cwd, ".env") }),
      code: "HARD_DENY_SECRET_PATH",
    },
    {
      name: "permission-control write",
      toolName: "write",
      input: (): Record<string, unknown> => ({
        path: join(cwd, ".pi", "agents", "worker.md"),
        content: "---",
      }),
      code: "HARD_DENY_PERMISSION_CONTROL",
    },
    {
      name: "catastrophic deletion",
      toolName: "bash",
      input: (): Record<string, unknown> => ({ command: "rm -rf /" }),
      code: "HARD_DENY_CATASTROPHIC_DELETE",
    },
  ])("keeps Issue #10 hard deny for $name", async ({ toolName, input, code }) => {
    const { result, safeAllow } = await evaluateWithProfile(toolName, input());

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining(code),
    });
    expect(safeAllow).not.toHaveBeenCalled();
  });
});
