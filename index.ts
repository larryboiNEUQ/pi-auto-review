/**
 * Single Pi extension entry for the pi-auto-review package.
 *
 * Both factories live in this repository (workspace packages). Composing them
 * here keeps load order (permission-system, then safe-allow) while presenting
 * one resource in `pi config` / startup lists. Runtime cost is the same as
 * loading the two factories separately — no extra hot-path work.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import permissionSystem from "./packages/pi-permission-system/src/index.ts";
import safeAllow from "./packages/pi-permission-safe-allow/src/index.ts";

export default function piAutoReview(pi: ExtensionAPI): void {
  permissionSystem(pi);
  safeAllow(pi);
}
