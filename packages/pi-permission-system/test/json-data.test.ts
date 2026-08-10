import { describe, expect, it, vi } from "vitest";

import { isJsonDataRecord } from "#src/json-data";

describe("isJsonDataRecord", () => {
  it("accepts nested inert JSON-like argument records", () => {
    expect(isJsonDataRecord({ query: "issue", flags: [true, 2, null, { page: 1 }] })).toBe(true);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["custom prototype", Object.create({ inherited: true })],
    ["dangerous key", Object.defineProperty({}, "__proto__", { value: {}, enumerable: true })],
    ["symbol", { value: Symbol("x") }],
  ])("rejects %s data", (_label, value) => {
    expect(isJsonDataRecord(value)).toBe(false);
  });

  it("rejects cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(isJsonDataRecord(value)).toBe(false);
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "secret");
    const value = Object.defineProperty({}, "token", {
      enumerable: true,
      get: getter,
    });

    expect(isJsonDataRecord(value)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});
