import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted stubs for mocks that reference them in vi.mock factories.
const { mockSpawnSync, mockExistsSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

// Mock node:child_process so tests don't spawn real subprocesses.
vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
  default: { spawnSync: mockSpawnSync },
}));

// Mock node:fs so existsSync is controllable.
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  default: { existsSync: mockExistsSync },
}));

import { discoverGlobalNodeModulesRoot } from "#src/node-modules-discovery";

describe("discoverGlobalNodeModulesRoot", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockExistsSync.mockReset();
  });

  test("returns node_modules root when URL is inside a node_modules tree", () => {
    const nodeModulesRoot = join(sep, "opt", "homebrew", "lib", "node_modules");
    const fakeUrl = pathToFileURL(
      join(
        nodeModulesRoot,
        "@gotgenes",
        "pi-permission-system",
        "dist",
        "external-directory.js",
      ),
    ).href;
    const result = discoverGlobalNodeModulesRoot(fakeUrl);
    expect(result).toBe(nodeModulesRoot);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  test("calls npm root -g as fallback when walk-up finds no node_modules ancestor", () => {
    const npmRootPath = join(sep, "opt", "homebrew", "lib", "node_modules");
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: `${npmRootPath}\n`,
    });
    mockExistsSync.mockReturnValue(true);

    const fakeUrl = pathToFileURL(
      join(sep, "Users", "dev", "my-project", "src", "external-directory.ts"),
    ).href;
    const result = discoverGlobalNodeModulesRoot(fakeUrl);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "npm",
      ["root", "-g"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(result).toBe(npmRootPath);
  });

  test("returns null when walk-up fails and npm root -g returns non-zero exit", () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: "" });

    const fakeUrl = pathToFileURL(
      join(sep, "Users", "dev", "my-project", "src", "external-directory.ts"),
    ).href;
    const result = discoverGlobalNodeModulesRoot(fakeUrl);

    expect(result).toBeNull();
  });

  test("returns null when walk-up fails and spawnSync throws", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const fakeUrl = pathToFileURL(
      join(sep, "Users", "dev", "my-project", "src", "external-directory.ts"),
    ).href;
    const result = discoverGlobalNodeModulesRoot(fakeUrl);

    expect(result).toBeNull();
  });

  test("returns null when walk-up fails and npm root -g returns non-existent path", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: `${join(sep, "some", "nonexistent", "node_modules")}\n`,
    });
    mockExistsSync.mockReturnValue(false);

    const fakeUrl = pathToFileURL(
      join(sep, "Users", "dev", "my-project", "src", "external-directory.ts"),
    ).href;
    const result = discoverGlobalNodeModulesRoot(fakeUrl);

    expect(result).toBeNull();
  });

  test("returns null when walk-up fails and npm root -g returns empty stdout", () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "   " });

    const fakeUrl = pathToFileURL(
      join(sep, "Users", "dev", "my-project", "src", "external-directory.ts"),
    ).href;
    const result = discoverGlobalNodeModulesRoot(fakeUrl);

    expect(result).toBeNull();
  });
});
