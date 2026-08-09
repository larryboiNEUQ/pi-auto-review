import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ToolCallGatePipeline } from "#src/handlers/gates/tool-call-gate-pipeline";
import { posixPathFlavor, win32PathFlavor } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path-normalizer";

import {
  makeGateInputs,
  makeGateRunner,
  makeResolver,
  makeTcc,
} from "#test/helpers/gate-fixtures";
import { makeCheckResult } from "#test/helpers/handler-fixtures";

describe("built-in hard-deny routing", () => {
  it("blocks a shell profile before policy allow or safe-allow can loosen it", async () => {
    const resolver = makeResolver(
      makeCheckResult({ state: "allow", origin: "global", matchedPattern: "*" }),
    );
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, join(homedir(), "project")),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "write",
        input: { path: join(homedir(), ".zshrc"), content: "malicious" },
        cwd: join(homedir(), "project"),
      }),
      runner,
    );

    expect(outcome).toEqual({
      action: "block",
      code: "HARD_DENY_SHELL_PROFILE",
      reason:
        "HARD_DENY_SHELL_PROFILE: access to shell startup profiles is blocked by the built-in safety baseline",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.reporter.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "hard_deny",
        denyCode: "HARD_DENY_SHELL_PROFILE",
        origin: "builtin",
        matchedPattern: null,
      }),
    );
    expect(deps.reporter.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({
        resolution: "hard_denied",
        denyCode: "HARD_DENY_SHELL_PROFILE",
      }),
    );
  });

  it("blocks SSH authorized_keys before a yolo allow can loosen it", async () => {
    const resolver = makeResolver(
      makeCheckResult({ state: "allow", origin: "yolo", matchedPattern: "*" }),
    );
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, join(homedir(), "project")),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "edit",
        input: { path: join(homedir(), ".ssh", "authorized_keys") },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_SSH_AUTHORIZED_KEYS",
      reason: expect.stringContaining("SSH authorized_keys"),
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("blocks writes under user persistence-agent directories", async () => {
    const resolver = makeResolver(makeCheckResult({ state: "ask" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, join(homedir(), "project")),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "write",
        input: {
          path: join(
            homedir(),
            "Library",
            "LaunchAgents",
            "com.example.persistence.plist",
          ),
        },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERSISTENCE_AGENT",
      reason: expect.stringContaining("persistence-agent"),
    });
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("blocks a catastrophic root delete without entering safe-allow", async () => {
    const resolver = makeResolver(
      makeCheckResult({ state: "allow", origin: "global", matchedPattern: "*" }),
    );
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, join(homedir(), "project")),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({ toolName: "bash", input: { command: "rm -rf /" } }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_CATASTROPHIC_DELETE",
      reason: expect.stringContaining("catastrophic filesystem delete"),
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("blocks catastrophic home deletes expressed with braced expansion", async () => {
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, "/workspace/project"),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        input: { command: 'rm -rf "${HOME}"' },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_CATASTROPHIC_DELETE",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("blocks catastrophic deletes inside opaque shell wrappers", async () => {
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, "/workspace/project"),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    for (const command of [
      "bash -c 'rm -rf /'",
      "eval 'rm -rf /'",
      "sudo sh -c 'echo ok; rm -rf /'",
    ]) {
      const outcome = await pipeline.evaluate(
        makeTcc({ toolName: "bash", input: { command } }),
        runner,
      );
      expect(outcome).toMatchObject({
        action: "block",
        code: "HARD_DENY_CATASTROPHIC_DELETE",
      });
    }
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("blocks writes to permission-control surfaces", async () => {
    const cwd = "/workspace/project";
    const resolver = makeResolver(
      makeCheckResult({ state: "allow", origin: "global", matchedPattern: "*" }),
    );
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "write",
        cwd,
        input: {
          path: join(
            cwd,
            ".pi",
            "extensions",
            "pi-permission-system",
            "config.json",
          ),
        },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERMISSION_CONTROL",
      reason: expect.stringContaining("permission-control"),
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("blocks reads of high-sensitivity secret paths", async () => {
    const cwd = "/workspace/project";
    const resolver = makeResolver(makeCheckResult({ state: "ask" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "read",
        cwd,
        input: { path: join(cwd, ".env.production") },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_SECRET_PATH",
      reason: expect.stringContaining("high-sensitivity secret path"),
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("applies the secret-path hard deny to bash path access", async () => {
    const cwd = "/workspace/project";
    const resolver = makeResolver(
      makeCheckResult({ state: "allow", origin: "global", matchedPattern: "*" }),
    );
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        cwd,
        input: { command: "cat ./.env.production" },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_SECRET_PATH",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("uses canonical aliases to block a symlink to a private SSH key", async () => {
    const root = mkdtempSync(join(tmpdir(), "hard-deny-symlink-"));
    try {
      const cwd = join(root, "project");
      const sshDir = join(root, "home", ".ssh");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(sshDir, { recursive: true });
      const privateKey = join(sshDir, "id_ed25519");
      const link = join(cwd, "linked-key");
      writeFileSync(privateKey, "secret");
      symlinkSync(privateKey, link);

      const resolver = makeResolver(makeCheckResult({ state: "allow" }));
      const inputs = makeGateInputs({
        getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
      });
      const { runner, deps } = makeGateRunner();
      const pipeline = new ToolCallGatePipeline(resolver, inputs);

      const outcome = await pipeline.evaluate(
        makeTcc({ toolName: "read", cwd, input: { path: link } }),
        runner,
      );

      expect(outcome).toMatchObject({
        action: "block",
        code: "HARD_DENY_SECRET_PATH",
      });
      expect(deps.escalate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches SSH control paths with Windows flavor semantics", async () => {
    const cwd = "C:\\Users\\Alice\\project";
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(win32PathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "edit",
        cwd,
        input: { path: "c:\\users\\alice\\.SSH\\AUTHORIZED_KEYS" },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_SSH_AUTHORIZED_KEYS",
    });
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("applies shell-profile hard deny to bash redirections", async () => {
    const cwd = join(homedir(), "project");
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        cwd,
        input: { command: `printf evil > ${join(homedir(), ".zshrc")}` },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_SHELL_PROFILE",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("applies permission-control hard deny to bash redirections", async () => {
    const cwd = "/workspace/project";
    const controlPath = join(
      cwd,
      ".pi",
      "extensions",
      "pi-permission-system",
      "config.json",
    );
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        cwd,
        input: { command: `printf '{}' > ${controlPath}` },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERMISSION_CONTROL",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("does not hard-deny a read-only bash access to a control surface", async () => {
    const cwd = "/workspace/project";
    const controlPath = join(
      cwd,
      ".pi",
      "extensions",
      "pi-permission-system",
      "config.json",
    );
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        cwd,
        input: { command: `cat ${controlPath}` },
      }),
      runner,
    );

    expect(outcome).toEqual({ action: "allow" });
    expect(resolver.resolve).toHaveBeenCalled();
  });

  it("blocks catastrophic deletes expressed with separate long flags", async () => {
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, "/workspace/project"),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        input: { command: "rm --recursive --force -- /" },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_CATASTROPHIC_DELETE",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("blocks Linux user persistence-agent definitions", async () => {
    const cwd = "/home/alice/project";
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "write",
        cwd,
        input: {
          path: "/home/alice/.config/systemd/user/persistence.service",
        },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERSISTENCE_AGENT",
    });
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("protects the safe-allow authorizer configuration surface", async () => {
    const cwd = "/workspace/project";
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "write",
        cwd,
        input: {
          path: join(
            cwd,
            ".pi",
            "extensions",
            "pi-permission-safe-allow",
            "config.json",
          ),
        },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERMISSION_CONTROL",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("protects project-agent permission frontmatter", async () => {
    const cwd = "/workspace/project";
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "write",
        cwd,
        input: { path: join(cwd, ".pi", "agents", "worker.md") },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERMISSION_CONTROL",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("protects the operator-global permission configuration", async () => {
    const cwd = join(homedir(), "project");
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "write",
        cwd,
        input: {
          path: join(
            homedir(),
            ".pi",
            "agent",
            "extensions",
            "pi-permission-system",
            "config.json",
          ),
        },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERMISSION_CONTROL",
    });
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("hard-denies catastrophic deletes behind known indirection wrappers", async () => {
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, "/workspace/project"),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        input: { command: "sudo rm -rf --no-preserve-root /" },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_CATASTROPHIC_DELETE",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("applies SSH authorized_keys hard deny to bash mutation", async () => {
    const cwd = join(homedir(), "project");
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        cwd,
        input: {
          command: `printf key > ${join(homedir(), ".ssh", "authorized_keys")}`,
        },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_SSH_AUTHORIZED_KEYS",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("applies persistence-agent hard deny to bash mutation", async () => {
    const cwd = "/home/alice/project";
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () => new PathNormalizer(posixPathFlavor, cwd),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        cwd,
        input: {
          command:
            "printf x > /home/alice/.config/systemd/user/persistence.service",
        },
      }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_PERSISTENCE_AGENT",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("recognizes uppercase recursive rm flags as catastrophic", async () => {
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, "/workspace/project"),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({ toolName: "bash", input: { command: "rm -Rf /" } }),
      runner,
    );

    expect(outcome).toMatchObject({
      action: "block",
      code: "HARD_DENY_CATASTROPHIC_DELETE",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("does not treat an rm argument to a wrapped harmless command as executable", async () => {
    const resolver = makeResolver(makeCheckResult({ state: "allow" }));
    const inputs = makeGateInputs({
      getPathNormalizer: () =>
        new PathNormalizer(posixPathFlavor, "/workspace/project"),
    });
    const { runner, deps } = makeGateRunner();
    const pipeline = new ToolCallGatePipeline(resolver, inputs);

    const outcome = await pipeline.evaluate(
      makeTcc({
        toolName: "bash",
        input: { command: "sudo echo rm -rf /" },
      }),
      runner,
    );

    expect(outcome).toEqual({ action: "allow" });
    expect(resolver.resolve).toHaveBeenCalled();
    expect(deps.escalate).toHaveBeenCalledOnce();
  });
});
