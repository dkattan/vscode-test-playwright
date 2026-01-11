/*
 * Small WebSocket <-> vscode-jsonrpc transport.
 *
 * We intentionally keep this minimal and fail-fast: malformed messages or writes will throw.
 */

import type { EventEmitter } from "node:events";
import {
  type DataCallback,
  type Disposable,
  Emitter,
  type Event,
  type Message,
  type MessageReader,
  type MessageWriter,
  type PartialMessageInfo,
} from "vscode-jsonrpc";

export interface WsLike extends EventEmitter {
  send: (data: string) => void;
  close: () => void;
}

function asError(e: unknown): Error {
  if (e instanceof Error) {
    return e;
  }
  return new Error(String(e));
}

export class WebSocketMessageReader implements MessageReader {
  private readonly ws: WsLike;
  private cb: DataCallback | undefined;

  private readonly _onError = new Emitter<Error>();
  public readonly onError: Event<Error> = this._onError.event;

  private readonly _onClose = new Emitter<void>();
  public readonly onClose: Event<void> = this._onClose.event;

  private readonly _onPartialMessage = new Emitter<PartialMessageInfo>();
  public readonly onPartialMessage: Event<PartialMessageInfo> =
    this._onPartialMessage.event;

  constructor(ws: WsLike) {
    this.ws = ws;
  }

  listen(callback: DataCallback): Disposable {
    this.cb = callback;

    const onMessage = (raw: unknown) => {
      if (typeof raw !== "string") {
        throw new TypeError(
          `Expected WebSocket message payload to be a string, got ${typeof raw}`
        );
      }

      const parsed = JSON.parse(raw) as unknown;
      // vscode-jsonrpc expects JSON-RPC message objects.
      this.cb?.(parsed as Message);
    };

    const onError = (err: unknown) => {
      this._onError.fire(asError(err));
    };

    const onClose = () => {
      this._onClose.fire();
    };

    // ws (library) uses 'message'/'error'/'close'.
    this.ws.on("message", onMessage);
    this.ws.on("error", onError);
    this.ws.on("close", onClose);

    return {
      dispose: () => {
        this.ws.removeListener("message", onMessage);
        this.ws.removeListener("error", onError);
        this.ws.removeListener("close", onClose);
      },
    };
  }

  dispose(): void {
    this._onError.dispose();
    this._onClose.dispose();
    this._onPartialMessage.dispose();
  }
}

export class WebSocketMessageWriter implements MessageWriter {
  private readonly ws: WsLike;

  private readonly _onError = new Emitter<[Error, Message | undefined, number | undefined]>();
  public readonly onError: Event<[Error, Message | undefined, number | undefined]> =
    this._onError.event;

  private readonly _onClose = new Emitter<void>();
  public readonly onClose: Event<void> = this._onClose.event;

  constructor(ws: WsLike) {
    this.ws = ws;

    this.ws.on("error", (e: unknown) => {
      this._onError.fire([asError(e), undefined, undefined]);
    });
    this.ws.on("close", () => {
      this._onClose.fire();
    });
  }

  write(msg: Message): Promise<void> {
    try {
      this.ws.send(JSON.stringify(msg));
      return Promise.resolve();
    } catch (e) {
      const err = asError(e);
      this._onError.fire([err, msg, undefined]);
      return Promise.reject(err);
    }
  }

  end(): void {
    this.ws.close();
  }

  dispose(): void {
    this._onError.dispose();
    this._onClose.dispose();
  }
}
