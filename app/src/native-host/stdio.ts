/**
 * Native Messaging stdio transport.
 *
 * Native messaging uses length-prefixed JSON messages:
 * - 4-byte little-endian uint32 containing message length
 * - UTF-8 encoded JSON message
 *
 * Max message size from native app: 1 MB
 * Max message size to native app: 4 GB
 *
 * For messages exceeding the 1MB limit, this transport automatically
 * chunks them into smaller pieces with metadata for reassembly.
 */

type MessageHandler = (message: unknown) => void;

// Chrome's native messaging limit is 1MB, use 900KB to leave room for chunk metadata
const MAX_CHUNK_SIZE = 900 * 1024;

/**
 * Chunk metadata for reassembling large messages
 */
interface ChunkedMessage {
  __chunked: true;
  chunkId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

export class StdioTransport {
  private messageHandler: MessageHandler | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private chunkCounter = 0;

  constructor() {
    this.setupStdinReader();
  }

  /**
   * Register a handler for incoming messages from the extension.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Send a message to the extension.
   * If the message exceeds 900KB, it's automatically chunked.
   */
  send(message: unknown): void {
    const json = JSON.stringify(message);
    const byteLength = Buffer.byteLength(json, "utf-8");

    if (byteLength <= MAX_CHUNK_SIZE) {
      // Message fits in a single chunk, send directly
      this.writeMessage(json);
    } else {
      // Message too large, chunk it
      this.sendChunked(json);
    }
  }

  /**
   * Split a large message into chunks and send each one.
   */
  private sendChunked(json: string): void {
    const chunkId = `chunk_${Date.now()}_${this.chunkCounter++}`;
    const chunks: string[] = [];

    // Split into chunks (by character, since we're dealing with JSON string)
    // We need to account for chunk metadata overhead (~200 bytes)
    const effectiveChunkSize = MAX_CHUNK_SIZE - 200;

    for (let i = 0; i < json.length; i += effectiveChunkSize) {
      chunks.push(json.slice(i, i + effectiveChunkSize));
    }

    console.error(`Chunking message: ${json.length} bytes into ${chunks.length} chunks (id: ${chunkId})`);

    // Send each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunkedMessage: ChunkedMessage = {
        __chunked: true,
        chunkId,
        chunkIndex: i,
        totalChunks: chunks.length,
        data: chunks[i],
      };
      this.writeMessage(JSON.stringify(chunkedMessage));
    }
  }

  /**
   * Write a single message to stdout using native messaging protocol.
   */
  private writeMessage(json: string): void {
    const jsonBuffer = Buffer.from(json, "utf-8");
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(jsonBuffer.length, 0);

    process.stdout.write(lengthBuffer);
    process.stdout.write(jsonBuffer);
  }

  /**
   * Set up stdin to read length-prefixed messages.
   */
  private setupStdinReader(): void {
    process.stdin.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });

    process.stdin.on("end", () => {
      // Extension closed the connection
      process.exit(0);
    });

    process.stdin.on("error", (err) => {
      console.error("stdin error:", err);
      process.exit(1);
    });
  }

  /**
   * Process buffered data, extracting complete messages.
   */
  private processBuffer(): void {
    while (this.buffer.length >= 4) {
      // Read message length (4-byte LE uint32)
      const messageLength = this.buffer.readUInt32LE(0);

      // Check if we have the complete message
      if (this.buffer.length < 4 + messageLength) {
        // Wait for more data
        return;
      }

      // Extract the message
      const messageBuffer = this.buffer.subarray(4, 4 + messageLength);
      const messageJson = messageBuffer.toString("utf-8");

      // Remove processed data from buffer
      this.buffer = this.buffer.subarray(4 + messageLength);

      // Parse and dispatch (pass through as-is)
      try {
        const message = JSON.parse(messageJson);
        if (this.messageHandler) {
          this.messageHandler(message);
        }
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    }
  }
}
