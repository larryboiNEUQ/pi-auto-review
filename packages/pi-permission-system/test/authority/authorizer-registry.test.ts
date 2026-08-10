import { describe, expect, test } from "vitest";

import type { Authorizer } from "#src/authority/authorizer";
import { AuthorizerRegistry } from "#src/authority/authorizer-registry";

const noopLink: Authorizer["authorize"] = () =>
  Promise.resolve({ kind: "defer" });

describe("AuthorizerRegistry", () => {
  describe("register", () => {
    test("stores a link with the safe default path envelope mode", () => {
      const registry = new AuthorizerRegistry();
      registry.register("model-judge", noopLink);
      expect(registry.get("model-judge")).toBe(noopLink);
      expect(registry.getPathEnvelopeMode("model-judge")).toBe("cap-allow");
    });

    test("stores an explicit path envelope opt-out", () => {
      const registry = new AuthorizerRegistry();
      registry.register("model-judge", noopLink, {
        pathEnvelopeMode: "honor-reviewer",
      });
      expect(registry.getPathEnvelopeMode("model-judge")).toBe(
        "honor-reviewer",
      );
    });

    test("returns a disposer that removes the link and its mode", () => {
      const registry = new AuthorizerRegistry();
      const dispose = registry.register("model-judge", noopLink, {
        pathEnvelopeMode: "honor-reviewer",
      });
      dispose();
      expect(registry.get("model-judge")).toBeUndefined();
      expect(registry.getPathEnvelopeMode("model-judge")).toBe("cap-allow");
    });

    test("throws when a link is already registered for the same name", () => {
      const registry = new AuthorizerRegistry();
      registry.register("model-judge", noopLink);
      expect(() =>
        registry.register("model-judge", () =>
          Promise.resolve({ kind: "defer" }),
        ),
      ).toThrow("model-judge");
    });

    test("allows registering different names independently", () => {
      const registry = new AuthorizerRegistry();
      const linkA: Authorizer["authorize"] = () =>
        Promise.resolve({ kind: "allow" });
      const linkB: Authorizer["authorize"] = () =>
        Promise.resolve({ kind: "deny" });
      registry.register("judge-a", linkA);
      registry.register("judge-b", linkB);
      expect(registry.get("judge-a")).toBe(linkA);
      expect(registry.get("judge-b")).toBe(linkB);
    });
  });

  describe("disposer identity guard", () => {
    test("stale disposer does not evict a later registration", () => {
      const registry = new AuthorizerRegistry();
      const first: Authorizer["authorize"] = () =>
        Promise.resolve({ kind: "defer" });
      const second: Authorizer["authorize"] = () =>
        Promise.resolve({ kind: "allow" });

      const disposeFirst = registry.register("model-judge", first);
      disposeFirst(); // removes first

      registry.register("model-judge", second, {
        pathEnvelopeMode: "honor-reviewer",
      }); // second registration is valid
      disposeFirst(); // stale disposer again — must not remove second

      expect(registry.get("model-judge")).toBe(second);
      expect(registry.getPathEnvelopeMode("model-judge")).toBe(
        "honor-reviewer",
      );
    });
  });

  describe("get", () => {
    test("returns undefined for an unregistered name", () => {
      const registry = new AuthorizerRegistry();
      expect(registry.get("unknown")).toBeUndefined();
    });
  });
});
