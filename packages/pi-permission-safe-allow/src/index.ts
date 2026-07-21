import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSafeAllowExtension } from "./extension";

/**
 * Entry: register allow-capable external_directory model judge as
 * authorizer chain link "safe-allow".
 */
export default function safeAllowExtension(pi: ExtensionAPI): void {
  createSafeAllowExtension(pi);
}
