/** Keep host identity in Pi's aliased TypeScript loader, outside native bundle resolution. */
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import composition from "./index.js";

export default function piAutoReviewEntry(pi: ExtensionAPI): void {
  composition(pi, { hostVersion: VERSION });
}
