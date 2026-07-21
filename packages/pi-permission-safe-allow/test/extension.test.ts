import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  publishPermissionsService,
  unpublishPermissionsService,
  type PermissionsService,
} from "@gotgenes/pi-permission-system";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withDefaults } from "#safe/config-schema";
import { createSafeAllowExtension } from "#safe/extension";

describe("safe-allow extension integration", () => {
  let published: PermissionsService | undefined;

  afterEach(() => {
    if (published) unpublishPermissionsService(published);
    published = undefined;
  });

  it("registers the delegated reviewer and /approve command on a real session lifecycle", async () => {
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const commands = new Map<string, unknown>();
    const pi = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      events: { on: vi.fn().mockReturnValue(() => undefined) },
      registerCommand: vi.fn((name: string, definition: unknown) => {
        commands.set(name, definition);
      }),
    } as unknown as ExtensionAPI;

    const registerAuthorizer = vi.fn().mockReturnValue(() => undefined);
    published = {
      checkPermission: vi.fn(),
      getToolPermission: vi.fn(),
      registerToolInputFormatter: vi.fn(),
      registerToolAccessExtractor: vi.fn(),
      registerAuthorizer,
    } as unknown as PermissionsService;
    publishPermissionsService(published);

    createSafeAllowExtension(pi, {
      loadConfig: () => ({ config: withDefaults({}), issues: [] }),
      complete: vi.fn(),
    });

    const ctx = {
      cwd: "/work/repo",
      modelRegistry: { find: vi.fn() },
      sessionManager: { getEntries: vi.fn().mockReturnValue([]) },
      ui: { notify: vi.fn(), select: vi.fn() },
      abort: vi.fn(),
    } as unknown as ExtensionContext;
    await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);

    expect(registerAuthorizer).toHaveBeenCalledWith("safe-allow", expect.any(Function));
    expect(commands.has("approve")).toBe(true);

    await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
  });
});
