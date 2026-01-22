import type { Socket } from "node:net";
import type { WebSocket } from "ws";

import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  type WsLike,
} from "./jsonRpcWsTransport";

export type RpcTransport =
  | { kind: "ws"; socket: WebSocket }
  | { kind: "pipe"; socket: Socket };

export function createRpcConnection(transport: RpcTransport): MessageConnection {
  if (transport.kind === "ws") {
    const reader = new WebSocketMessageReader(transport.socket as unknown as WsLike);
    const writer = new WebSocketMessageWriter(transport.socket as unknown as WsLike);
    return createMessageConnection(reader, writer);
  }

  // net.Socket is a Duplex stream; vscode-jsonrpc's Stream* transports use the
  // standard Content-Length framing.
  return createMessageConnection(
    new StreamMessageReader(transport.socket),
    new StreamMessageWriter(transport.socket)
  );
}

export function closeRpcTransport(transport: RpcTransport): void {
  try {
    if (transport.kind === "ws") {
      transport.socket.close();
    } else {
      // destroy() is the most reliable way to terminate a pipe/socket.
      transport.socket.destroy();
    }
  } catch {
    // ignore
  }

  try {
    // Both ws.WebSocket and net.Socket are EventEmitters.
    (transport.socket as unknown as { removeAllListeners: () => void }).removeAllListeners();
  } catch {
    // ignore
  }
}

export function waitForRpcTransportClose(transport: RpcTransport): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;

    const finish = (err?: unknown) => {
      if (done) {
        return;
      }
      done = true;

      // Try to unhook listeners best-effort.
      try {
        if (transport.kind === "ws") {
          transport.socket.removeListener("close", onClose);
          transport.socket.removeListener("error", onError);
        } else {
          transport.socket.removeListener("close", onClose);
          transport.socket.removeListener("end", onClose);
          transport.socket.removeListener("error", onError);
        }
      } catch {
        // ignore
      }

      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const onClose = () => finish();
    const onError = (err: unknown) => finish(err);

    if (transport.kind === "ws") {
      transport.socket.once("close", onClose);
      transport.socket.once("error", onError);
      return;
    }

    transport.socket.once("close", onClose);
    transport.socket.once("end", onClose);
    transport.socket.once("error", onError);
  });
}
