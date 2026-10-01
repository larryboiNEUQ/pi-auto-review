import { describe, expect, it } from "vitest";
import { supportsBatchCancellation } from "#src/authority/host-cancellation";

describe("native host cancellation compatibility", () => {
  it.each(["0.85.1", "0.85.2", "0.99.1", "0.99.1+packaged", "1.0.0"])("admits stable compatible host %s", (version) => {
    expect(supportsBatchCancellation(version)).toBe(true);
  });
  it.each([undefined, "unknown", "0.81.0", "0.84.4", "0.85.0", "0.99.1-rc.1", "v0.99.1", "00.99.1", "0.99", "999999999999999999999.1.1"])("rejects unsupported or unverified host %s", (version) => {
    expect(supportsBatchCancellation(version)).toBe(false);
  });
});
