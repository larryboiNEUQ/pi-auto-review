import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logSafeAllow } from "#safe/log";

describe("logSafeAllow console surface", () => {
  const originalVerbose = process.env.PI_SAFE_ALLOW_VERBOSE;

  beforeEach(() => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-permission-safe-allow-log-tests";
    delete process.env.PI_SAFE_ALLOW_VERBOSE;
  });

  afterEach(() => {
    if (originalVerbose === undefined) {
      delete process.env.PI_SAFE_ALLOW_VERBOSE;
    } else {
      process.env.PI_SAFE_ALLOW_VERBOSE = originalVerbose;
    }
    vi.restoreAllMocks();
  });

  it("keeps routine lifecycle events off the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logSafeAllow("register.skip", { reason: "already_registered" });
    logSafeAllow("session_start", { cwd: "/tmp" });
    logSafeAllow("session_shutdown", {});
    logSafeAllow("register.ok", { source: "session_start" });
    logSafeAllow("extension_loaded", {});

    expect(warn).not.toHaveBeenCalled();
  });

  it("surfaces exceptional events on the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logSafeAllow("register.fail", { reason: "permissions_service_missing" });
    logSafeAllow("config.issue", { path: "model", message: "bad" });
    logSafeAllow("denial.circuit_breaker", { kind: "consecutive" });
    logSafeAllow("review.failure", { code: "timeout" });

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]?.[0]).toContain("register.fail");
  });

  it("surfaces every event when PI_SAFE_ALLOW_VERBOSE=1", () => {
    process.env.PI_SAFE_ALLOW_VERBOSE = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logSafeAllow("register.skip", { reason: "already_registered" });
    logSafeAllow("session_shutdown", {});

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
