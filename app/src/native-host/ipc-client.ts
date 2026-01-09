/**
 * IPC client for connecting to the Electron app.
 *
 * Uses Unix domain sockets on macOS/Linux and named pipes on Windows.
 * Protocol: newline-delimited JSON messages.
 *
 * This is a pure relay - messages are passed through as-is without
 * any transformation. Compression is handled end-to-end between
 * the extension and Electron app.
 */

import { Socket, connect } from "net";
import { dirname } from "path";
import { mkdirSync, existsSync } from "fs";
import { getSocketPath } from "../shared/paths.js";

type MessageHandler = (message: unknown) => void;
type CloseHandler = () => void;

export class IpcClient {
  private socket: Socket | null = null;
  private messageHandler: MessageHandler | null = null;
  private closeHandler: CloseHandler | null = null;
  private buffer: string = "";
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 500;

  /**
   * Register a handler for incoming messages from the Electron app.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Register a handler for connection close.
   */
  onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  /**
   * Connect to the Electron app's IPC socket.
   * Returns a promise that resolves when connected.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketPath = getSocketPath();

      // Ensure socket directory exists (for Unix sockets)
      if (process.platform !== "win32") {
        const socketDir = dirname(socketPath);
        if (!existsSync(socketDir)) {
          mkdirSync(socketDir, { recursive: true });
        }
      }

      this.socket = connect(socketPath, () => {
        this.reconnectAttempts = 0;
        resolve();
      });

      this.socket.on("data", (data: Buffer) => {
        this.handleData(data.toString("utf-8"));
      });

      this.socket.on("close", () => {
        this.socket = null;
        if (this.closeHandler) {
          this.closeHandler();
        }
      });

      this.socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
          // Electron app not running - retry with backoff
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * this.reconnectAttempts;
            setTimeout(() => {
              this.connect().then(resolve).catch(reject);
            }, delay);
          } else {
            reject(
              new Error(
                `Failed to connect to Electron app after ${this.maxReconnectAttempts} attempts`
              )
            );
          }
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Send a message to the Electron app.
   * Uses newline-delimited JSON.
   */
  send(message: unknown): void {
    if (!this.socket) {
      console.error("Cannot send: not connected to Electron app");
      return;
    }
    this.socket.write(JSON.stringify(message) + "\n");
  }

  /**
   * Close the connection.
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }

  /**
   * Process incoming data, handling newline-delimited JSON.
   */
  private handleData(data: string): void {
    this.buffer += data;

    // Process complete lines
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          if (this.messageHandler) {
            this.messageHandler(message);
          }
        } catch (err) {
          console.error("Failed to parse IPC message:", err);
        }
      }
    }
  }
}
