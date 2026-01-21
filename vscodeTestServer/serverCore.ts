import type { RawData, WebSocket } from "ws";
import * as vscode from "vscode";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc";
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  type WsLike,
} from "../jsonRpcWsTransport";
import {
  type DispatchEventParams,
  type InvokeMethodParams,
  type InvokeMethodResult,
  type RegisterEventParams,
  type ReleaseParams,
  RPC,
} from "../rpcTypes";

export class VSCodeTestServer {
  private readonly ws: WebSocket;
  private readonly connection: MessageConnection;
  private _lastObjectId = 0;
  private _objectsById = new Map<number, unknown>([[0, vscode]]);
  private _idByObjects = new Map<object, number>(
    [[vscode as unknown as object, 0]]
  );
  private _eventEmitters = new Map<
    number,
    vscode.Disposable & { listenerCount: number }
  >();

  constructor(ws: WebSocket) {
    this.ws = ws;
    const reader = new WebSocketMessageReader(ws as unknown as WsLike);
    const writer = new WebSocketMessageWriter(ws as unknown as WsLike);
    this.connection = createMessageConnection(reader, writer);

    this.connection.onRequest(RPC.release, (p: ReleaseParams) => {
      this._release(p);
      return undefined;
    });
    this.connection.onRequest(RPC.registerEvent, (p: RegisterEventParams) => {
      this._registerEvent(p);
      return undefined;
    });
    this.connection.onRequest(RPC.unregisterEvent, (p: RegisterEventParams) => {
      this._unregisterEvent(p);
      return undefined;
    });
    this.connection.onRequest(
      RPC.invokeMethod,
      async (p: InvokeMethodParams): Promise<InvokeMethodResult> =>
        await this._invokeMethod(p)
    );
  }

  async run() {
    // Begin listening immediately. The Node harness may send requests as soon as
    // the TCP handshake completes.
    this.connection.listen();

    await Promise.all([
      // returning from run() will kill vscode before electron.close(), so we need to hang it until process exit
      new Promise((resolve) => process.on("exit", resolve)),
      new Promise<void>((resolve, reject) => {
        this.ws.on("message", (_data: RawData) => {
          // Handled by WebSocketMessageReader via vscode-jsonrpc.
        });
        this.ws.on("error", reject);
        this.ws.on("close", resolve);
      }).finally(() => this.dispose()),
    ]);
  }

  dispose() {
    this.connection.dispose();
    this.ws.close();
    const emitters = this._eventEmitters.values();
    this._eventEmitters.clear();
    for (const emitter of emitters) {
      emitter.dispose();
    }
  }

  private async _invokeMethod({
    objectId,
    fn,
    params,
    returnHandle,
  }: InvokeMethodParams): Promise<InvokeMethodResult> {
    const context = objectId === 0 ? vscode : this._objectsById.get(objectId);
    if (!context) {
      throw new Error(`No object with ID ${objectId} found`);
    }

    // eslint-disable-next-line no-new-func
    const func = new Function(
      `return ${fn}`
    )() as (on: unknown, ...args: unknown[]) => unknown | Thenable<unknown>;
    let result: unknown;
    let error: InvokeMethodResult["error"];

    try {
      result = await func(context, ...this._fromParams(params));
      if (returnHandle) {
        if (typeof result !== "object" || result === null) {
          throw new TypeError(
            "Cannot create a handle for a non-object result when returnHandle=true"
          );
        }

        let id = this._idByObjects.get(result);
        if (id === undefined) {
          id = ++this._lastObjectId;
          this._objectsById.set(id, result);
          this._idByObjects.set(result, id);
          if (result instanceof vscode.EventEmitter) {
            const { dispose } = result.event((e) => this._emit(id!, e));
            this._eventEmitters.set(id, { dispose, listenerCount: 0 });
            result = {
              __vscodeHandle: "eventEmitter",
              objectId: id,
            };
          } else {
            result = {
              __vscodeHandle: true,
              objectId: id,
            };
          }
        }
      }
    } catch (e: unknown) {
      const err = e as { message?: string; stack?: string; name?: string };
      error = {
        message: err?.message ?? String(e),
        stack: err?.stack,
        name: err?.name,
      };
    }

    return { result, ...(error ? { error } : {}) };
  }

  private _unregisterEvent({ objectId }: RegisterEventParams) {
    const event = this._eventEmitters.get(objectId);
    if (!event) {
      throw new Error(`No event emitter registered for objectId=${objectId}`);
    }
    if (event.listenerCount <= 0) {
      throw new Error(`unregisterEvent underflow for objectId=${objectId}`);
    }
    event.listenerCount--;
  }

  private _registerEvent({ objectId }: RegisterEventParams) {
    const event = this._eventEmitters.get(objectId);
    if (!event) {
      throw new Error(`No event emitter registered for objectId=${objectId}`);
    }
    event.listenerCount++;
  }

  private _release({ objectId, dispose }: ReleaseParams) {
    const obj = this._objectsById.get(objectId);
    if (obj !== undefined) {
      this._objectsById.delete(objectId);
      if (typeof obj === "object" && obj !== null) {
        this._idByObjects.delete(obj);
      }
      this._eventEmitters.get(objectId)?.dispose();
      this._eventEmitters.delete(objectId);
      if (dispose) {
        (obj as { dispose?: () => void }).dispose?.();
      }
    }
  }

  private _fromParams(params: unknown[]): unknown[] {
    return params.map((p) => this._fromParam(p));
  }

  private _fromParam(param: unknown): unknown {
    if (param === null) {
      return null;
    }
    if (["string", "number", "boolean", "undefined"].includes(typeof param)) {
      return param;
    }
    if (
      typeof param === "object" &&
      param !== null &&
      "__vscodeHandle" in param &&
      "objectId" in param
    ) {
      const p = param as { objectId: number };
      return this._objectsById.get(p.objectId);
    }
    if (Array.isArray(param)) {
      return param.map((v) => this._fromParam(v));
    }
    return Object.fromEntries(
      Object.entries(param as Record<string, unknown>).map(([k, v]) => [
        k,
        this._fromParam(v),
      ])
    );
  }

  private _emit(objectId: number, event: unknown) {
    const emitter = this._eventEmitters.get(objectId);
    if (emitter && emitter.listenerCount > 0) {
      const payload: DispatchEventParams = { objectId, event };
      void this.connection.sendNotification(RPC.dispatchEvent, payload);
    }
  }
}
