const GLOBAL_KEYS = [
  Symbol.for("@gotgenes/pi-permission-system:service"),
  Symbol.for("@gotgenes/pi-permission-system:subagent-registry"),
];

/** Clear process-global extension state between composition-root tests. */
export function resetPermissionSystemGlobals(): void {
  const store = globalThis as Record<symbol, unknown>;
  for (const key of GLOBAL_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test isolation for Symbol-keyed globals
    delete store[key];
  }
}
