import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadSafeAllowConfig,
} from "#safe/config-loader";
import {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_MODEL,
  DEFAULT_POLICY,
  withDefaults,
} from "#safe/config-schema";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "safe-allow-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Guardian policy config", () => {
  it("ships explicit outcome rules without claiming sandbox containment", () => {
    expect(DEFAULT_POLICY).toContain("## Data exfiltration");
    expect(DEFAULT_POLICY).toContain("## Credential probing");
    expect(DEFAULT_POLICY).toContain("## Persistent security weakening");
    expect(DEFAULT_POLICY).toContain("## Destructive actions");
    expect(DEFAULT_POLICY).toContain("Do not infer safety from OS sandboxing");
  });

  it("defines scope as exact-action blast radius and does not score task narrative", () => {
    expect(DEFAULT_MODEL).toBe("gpt-5.4-mini");
    for (const text of [DEFAULT_INSTRUCTIONS, DEFAULT_POLICY]) {
      expect(text).toMatch(/blast radius/i);
      expect(text).toMatch(/task narrative/i);
      expect(text).toMatch(/must not (set scope|raise riskLevel)/i);
    }
    expect(DEFAULT_POLICY).toMatch(/installed-skill|installed skill/i);
    expect(DEFAULT_POLICY).toMatch(/herdr/i);
    expect(DEFAULT_POLICY).toMatch(/unread/i);
    expect(DEFAULT_POLICY).toMatch(/do not inflate risk/i);
  });

  it("defaults tool results off and loads an explicit opt-in", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(loadSafeAllowConfig({ agentDir, cwd }).config.includeToolResults).toBe(false);

    writeFileSync(configPath, JSON.stringify({ includeToolResults: true }));
    expect(loadSafeAllowConfig({ agentDir, cwd }).config.includeToolResults).toBe(true);
  });

  it("defaults the path envelope to cap-allow and loads operator opt-out", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(loadSafeAllowConfig({ agentDir, cwd }).config.pathEnvelopeMode).toBe(
      "cap-allow",
    );

    writeFileSync(
      configPath,
      JSON.stringify({ pathEnvelopeMode: "honor-reviewer" }),
    );
    expect(loadSafeAllowConfig({ agentDir, cwd }).config.pathEnvelopeMode).toBe(
      "honor-reviewer",
    );
  });

  it("defaults read-only probes off and loads explicit bounded probe settings", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(loadSafeAllowConfig({ agentDir, cwd }).config).toMatchObject({
      readOnlyProbes: false,
      probeMaxHops: 1,
      probeTimeoutMs: 1_000,
    });

    writeFileSync(configPath, JSON.stringify({
      readOnlyProbes: true,
      probeMaxHops: 2,
      probeTimeoutMs: 250,
    }));
    expect(loadSafeAllowConfig({ agentDir, cwd }).config).toMatchObject({
      readOnlyProbes: true,
      probeMaxHops: 1,
      probeTimeoutMs: 250,
    });
  });

  it("maps every finite positive probe hop budget to the single lookup", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ probeMaxHops: 0.5 }));

    expect(loadSafeAllowConfig({ agentDir, cwd }).config.probeMaxHops).toBe(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "fails closed for non-finite probe hop budget %s",
    (probeMaxHops) => {
      expect(withDefaults({ readOnlyProbes: true, probeMaxHops }).probeMaxHops).toBe(0);
    },
  );

  it("keeps a positive fractional probe timeout above zero", () => {
    expect(withDefaults({ probeTimeoutMs: 0.5 }).probeTimeoutMs).toBe(1);
  });

  it("hard-caps configured probe hops and timeout", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      readOnlyProbes: true,
      probeMaxHops: 100,
      probeTimeoutMs: 60_000,
    }));

    expect(loadSafeAllowConfig({ agentDir, cwd }).config).toMatchObject({
      readOnlyProbes: true,
      probeMaxHops: 1,
      probeTimeoutMs: 5_000,
    });
  });

  it("loads an operator policy path relative to its config file", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    const policy = "ORG POLICY: deny exporting customer records.";
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(dirname(configPath), "guardian.md"), policy);
    writeFileSync(configPath, JSON.stringify({ policyPath: "guardian.md" }));

    const result = loadSafeAllowConfig({ agentDir, cwd });

    expect(result.issues).toEqual([]);
    expect(result.config.policy).toBe(policy);
  });

  it("lets a project policy path override the global policy", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const globalConfigPath = getGlobalConfigPath(agentDir);
    const projectConfigPath = getProjectConfigPath(cwd);
    mkdirSync(dirname(globalConfigPath), { recursive: true });
    mkdirSync(dirname(projectConfigPath), { recursive: true });
    writeFileSync(join(dirname(globalConfigPath), "guardian.md"), "GLOBAL POLICY");
    writeFileSync(globalConfigPath, JSON.stringify({ policyPath: "guardian.md" }));
    writeFileSync(join(dirname(projectConfigPath), "guardian.md"), "PROJECT POLICY");
    writeFileSync(projectConfigPath, JSON.stringify({ policyPath: "guardian.md" }));

    const result = loadSafeAllowConfig({ agentDir, cwd });

    expect(result.issues).toEqual([]);
    expect(result.config.policy).toBe("PROJECT POLICY");
  });

  it("lets a valid project policy recover from an invalid global policy", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const globalConfigPath = getGlobalConfigPath(agentDir);
    const projectConfigPath = getProjectConfigPath(cwd);
    mkdirSync(dirname(globalConfigPath), { recursive: true });
    mkdirSync(dirname(projectConfigPath), { recursive: true });
    writeFileSync(globalConfigPath, JSON.stringify({ policyPath: "missing.md" }));
    writeFileSync(join(dirname(projectConfigPath), "guardian.md"), "PROJECT POLICY");
    writeFileSync(projectConfigPath, JSON.stringify({ policyPath: "guardian.md" }));

    const result = loadSafeAllowConfig({ agentDir, cwd });

    expect(result.config.policy).toBe("PROJECT POLICY");
    expect(result.config.disabled).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  it("defers to the terminal when the configured policy cannot be read", () => {
    const root = temporaryRoot();
    const agentDir = join(root, "agent");
    const cwd = join(root, "repo");
    const configPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ policyPath: "missing.md" }));

    const result = loadSafeAllowConfig({ agentDir, cwd });

    expect(result.config.policy).toBe(DEFAULT_POLICY);
    expect(result.config.disabled).toBe(true);
    expect(result.issues).toMatchObject([
      { path: "$.policyPath", sourcePath: join(dirname(configPath), "missing.md") },
    ]);
  });
});
