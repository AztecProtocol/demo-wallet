/**
 * Types for the interactive-handshake sender relay: a manual, wallet-chosen channel that carries
 * the HandshakeRegistry's signature request out to the recipient's wallet (as a QR code / copied
 * blob) and the recipient's signed authorization back (pasted in). See the wallet worker's
 * `resolveCustomRequest` hook (built from `createInteractiveHandshakeResolver`) for the producing
 * side and `HandshakeRelayDialog` for the UI. The blobs are the delivery zod types round-tripped
 * with `jsonStringify` / `JSON.parse` + `Schema.parse`.
 */

/** A pending relay: the sender's request envelope, shown to the user to hand to the recipient. */
export type HandshakeRelayRequest = {
  id: string;
  /** The app whose send triggered the handshake (informational; the relay is user-driven). */
  appId: string;
  /** The `InteractiveHandshakeCustomRequest`, `jsonStringify`'d. Encodes to a QR / copy blob. */
  requestBlob: string;
  timestamp: number;
};

/** The user's reply to a relay: the recipient's `RecipientSignature` blob, or a cancellation. */
export type HandshakeRelayResponse = {
  id: string;
  approved: boolean;
  /** The recipient's `RecipientSignature`, `jsonStringify`'d, pasted back. Absent when cancelled. */
  signatureBlob?: string;
};
