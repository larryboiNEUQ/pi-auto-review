/**
 * Composition source for the pi-auto-review package.
 *
 * Pi loads the **precompiled** `./index.js` (see `pi.extensions` and
 * `npm run build`). This TypeScript file is the esbuild entry: both factories
 * live in this repository and run in order (permission-system, then safe-allow).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import permissionSystem from "./packages/pi-permission-system/src/index.ts";
import safeAllow from "./packages/pi-permission-safe-allow/src/index.ts";

export default function piAutoReview(pi: ExtensionAPI): void {
  permissionSystem(pi);
  safeAllow(pi);
}
