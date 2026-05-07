/**
 * Wallet `wallet-update`, `authorization-request`, and
 * `proof-debug-export-request` events are emitted with `detail: jsonStringify(content)`.
 * Both UI surfaces and the SW's broadcast subscribers need to parse on receive.
 * Unrecognized non-JSON strings (or already-object payloads) pass through unchanged.
 */
export function parseEventDetail(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
