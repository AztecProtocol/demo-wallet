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
 * This is a pure relay - messages are passed through as-is without
 * any transformation. Compression is handled end-to-end between
 * the extension and Electron app.
 */

type MessageHandler = (message: unknown) => void;

export class StdioTransport {
  private messageHandler: MessageHandler | null = null;
  private buffer: Buffer = Buffer.alloc(0);

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
   * Writes length-prefixed JSON to stdout.
   */
  send(message: unknown): void {
    const json = JSON.stringify(message);
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
