import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSafeAllowExtension } from "./extension";

/**
 * Entry: register the Codex-aligned delegated reviewer as authorizer-chain
 * link "safe-allow". It reviews eligible asks without changing deterministic
 * permission boundaries or claiming OS-sandbox containment.
 */
export default function safeAllowExtension(pi: ExtensionAPI): void {
  createSafeAllowExtension(pi);
}
