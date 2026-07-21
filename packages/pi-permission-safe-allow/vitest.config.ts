import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#safe": path.resolve(import.meta.dirname, "src"),
      "#src": path.resolve(import.meta.dirname, "../pi-permission-system/src"),
      "#test": path.resolve(import.meta.dirname, "test"),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
