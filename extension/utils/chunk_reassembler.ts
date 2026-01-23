/**
 * Reassembles chunked messages from native messaging.
 *
 * Native messaging has a 1MB message size limit. When the native host
 * needs to send larger messages, it chunks them and sends each chunk
 * with metadata for reassembly.
 */

/**
 * Chunk metadata for reassembling large messages from native host.
 */
interface ChunkedMessage {
  __chunked: true;
  chunkId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

/**
 * Tracks partial chunks being reassembled.
 */
interface PendingChunks {
  chunks: (string | undefined)[];
  receivedCount: number;
  totalChunks: number;
  createdAt: number;
}

/**
 * Reassembles chunked messages from native messaging.
 *
 * @example
 * ```typescript
 * const reassembler = new ChunkReassembler();
 *
 * nativePort.onMessage.addListener((message) => {
 *   const result = reassembler.process(message);
 *   if (result === null) return; // More chunks needed
 *   // result is the reassembled message
 * });
 *
 * // Clean up stale chunks periodically
 * setInterval(() => reassembler.cleanup(), 10000);
 * ```
 */
export class ChunkReassembler {
  private pendingChunks = new Map<string, PendingChunks>();
  private timeoutMs: number;

  constructor(timeoutMs = 30000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Check if a message is a chunk that needs reassembly.
   */
  private isChunkedMessage(message: unknown): message is ChunkedMessage {
    return (
      typeof message === "object" &&
      message !== null &&
      "__chunked" in message &&
      (message as ChunkedMessage).__chunked === true
    );
  }

  /**
   * Process an incoming message.
   *
   * @returns The original message if not chunked, the reassembled message
   *          if all chunks received, or null if more chunks are needed.
   */
  process<T = unknown>(message: unknown): T | null {
    if (!this.isChunkedMessage(message)) {
      return message as T;
    }

    const { chunkId, chunkIndex, totalChunks, data } = message;

    let pending = this.pendingChunks.get(chunkId);
    if (!pending) {
      pending = {
        chunks: new Array(totalChunks),
        receivedCount: 0,
        totalChunks,
        createdAt: Date.now(),
      };
      this.pendingChunks.set(chunkId, pending);
    }

    if (pending.chunks[chunkIndex] === undefined) {
      pending.chunks[chunkIndex] = data;
      pending.receivedCount++;
    }

    console.log(
      `Received chunk ${chunkIndex + 1}/${totalChunks} for ${chunkId} (${pending.receivedCount}/${totalChunks} received)`,
    );

    if (pending.receivedCount === totalChunks) {
      const fullJson = pending.chunks.join("");
      this.pendingChunks.delete(chunkId);
      console.log(`Reassembled chunked message: ${fullJson.length} bytes`);

      try {
        return JSON.parse(fullJson) as T;
      } catch (err) {
        console.error("Failed to parse reassembled message:", err);
        return null;
      }
    }

    return null;
  }

  /**
   * Clean up stale pending chunks that have exceeded the timeout.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [chunkId, pending] of this.pendingChunks) {
      if (now - pending.createdAt > this.timeoutMs) {
        console.warn(
          `Cleaning up stale chunks for ${chunkId} (${pending.receivedCount}/${pending.totalChunks} received)`,
        );
        this.pendingChunks.delete(chunkId);
      }
    }
  }
}
