import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

export default mergeConfig(baseConfig, {
  test: {
    setupFiles: ["./test/helpers/win32-platform-setup.ts"],
  },
});
