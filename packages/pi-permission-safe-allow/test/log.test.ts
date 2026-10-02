import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAFE_ALLOW_EXTENSION_ID } from "#safe/config-schema";
import { logSafeAllow } from "#safe/log";

describe("logSafeAllow diagnostic destinations", () => {
  const originalVerbose = process.env.PI_SAFE_ALLOW_VERBOSE;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "safe-allow-log-"));
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_SAFE_ALLOW_VERBOSE;
  });

  afterEach(() => {
    if (originalVerbose === undefined) delete process.env.PI_SAFE_ALLOW_VERBOSE;
    else process.env.PI_SAFE_ALLOW_VERBOSE = originalVerbose;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function records() {
    return readFileSync(join(root, "extensions", SAFE_ALLOW_EXTENSION_ID, "logs", "safe-allow.jsonl"), "utf-8")
      .trim().split("\n").map((line) => JSON.parse(line));
  }

  it("keeps all diagnostics off the terminal while preserving their audit records", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = ["register.skip", "session_start", "register.fail", "config.issue",
      "denial.circuit_breaker", "review.failure"];

    for (const event of events) expect(logSafeAllow(event, { code: "fixture" })).toBe(true);

    expect(warn).not.toHaveBeenCalled();
    expect(records().map(({ event, code }) => ({ event, code })))
      .toEqual(events.map((event) => ({ event, code: "fixture" })));
  });

  it("returns false without printing diagnostics when the audit destination is unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blocked = join(root, "file");
    writeFileSync(blocked, "not a directory");
    process.env.PI_CODING_AGENT_DIR = blocked;

    expect(logSafeAllow("review.failure", { code: "audit" })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("prints only redacted diagnostics when explicitly enabled", () => {
    process.env.PI_SAFE_ALLOW_VERBOSE = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const details = { authorization: "Bearer fixture-secret", nested: { apiKey: "fixture-key" } };

    expect(logSafeAllow("review.failure", details)).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("review.failure");
    const output = JSON.stringify(warn.mock.calls);
    expect(output).not.toContain("fixture-secret");
    expect(output).not.toContain("fixture-key");
    const saved = records()[0];
    expect(warn.mock.calls[0]?.[1]).toEqual({ authorization: saved.authorization, nested: saved.nested });
    expect(details.nested.apiKey).toBe("fixture-key");
  });
});
