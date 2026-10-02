// Exercise the plugin against an unmodified, separately installed native Pi.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const checkout = resolve(import.meta.dirname, "..");
const hostRoot = process.env.PI_AUTO_REVIEW_TEST_HOST_ROOT;
if (!hostRoot) throw new Error("Set PI_AUTO_REVIEW_TEST_HOST_ROOT to the native pi-coding-agent package directory.");
const hostRequire = createRequire(join(resolve(hostRoot), "package.json"));
export default {
  root: join(checkout, "packages/pi-permission-safe-allow"),
  resolve: { alias: {
    "@earendil-works/pi-coding-agent": join(resolve(hostRoot), "dist/index.js"),
    "@earendil-works/pi-agent-core": join(dirname(hostRequire.resolve("@earendil-works/pi-agent-core/package.json")), "dist/index.js"),
    "#safe": join(checkout, "packages/pi-permission-safe-allow/src"),
    "#src": join(checkout, "packages/pi-permission-system/src"),
    "#test": join(checkout, "packages/pi-permission-safe-allow/test"),
  } },
  test: {
    include: ["test/escalation.integration.test.ts", "test/native-stop-lifecycle.integration.test.ts"],
    testNamePattern: /per-call batched|host release capability|native stopping notice/,
  },
};
