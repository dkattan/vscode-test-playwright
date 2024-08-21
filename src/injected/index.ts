import { createServer } from "http";
import { AddressInfo } from "net";
import * as vscode from "vscode";
import { WebSocket, WebSocketServer } from "ws";
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

class VSCodeTestServer {
  private _ws: WebSocket;
  private readonly connection: MessageConnection;
  private _lastObjectId = 0;
  private _objectsById = new Map<number, any>([[0, vscode]]);
  private _idByObjects = new Map<any, number>([[vscode, 0]]);
  private _eventEmitters = new Map<
    number,
    { disposable: vscode.Disposable; listenerCount: number }
  >();

  constructor(ws: WebSocket) {
    this._ws = ws;

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
    this.connection.onRequest(
      RPC.unregisterEvent,
      (p: RegisterEventParams) => {
        this._unregisterEvent(p);
        return undefined;
      }
    );
    this.connection.onRequest(
      RPC.invokeMethod,
      async (p: InvokeMethodParams): Promise<InvokeMethodResult> =>
        await this._invokeMethod(p)
    );
  }

  async run() {
    this.connection.listen();
    await Promise.all([
      // returning from run() will kill vscode before electron.close(), so we need to hang it until process exit
      new Promise((resolve) => process.on("exit", resolve)),
      new Promise<void>((resolve, reject) => {
        this._ws.on("message", (_data) => {
          // Handled by WebSocketMessageReader via vscode-jsonrpc.
        });
        this._ws.on("error", reject);
        this._ws.on("close", resolve);
      }).finally(() => this.dispose()),
    ]);
  }

  dispose() {
    this.connection.dispose();
    this._ws.close();
    const emitters = this._eventEmitters.values();
    this._eventEmitters.clear();
    for (const emitter of emitters)
      emitter.disposable.dispose();
  }

  private async _invokeMethod({
    objectId,
    fn,
    params,
    returnHandle,
  }: InvokeMethodParams): Promise<InvokeMethodResult> {
    const context = !objectId ? vscode : this._objectsById.get(objectId);
    if (!context)
      throw new Error(`No object with ID ${objectId} found`);

    const func = new Function(`return ${fn}`)();
    let result: any;
    let error: InvokeMethodResult["error"];

    try {
      result = await func(context, ...this._fromParam(params));
      if (returnHandle) {
        let objectId = this._idByObjects.get(result);
        if (objectId === undefined) {
          objectId = ++this._lastObjectId;
          this._objectsById.set(objectId, result);
          this._idByObjects.set(result, objectId);
          if (result instanceof vscode.EventEmitter) {
            const id = objectId;
            const disposable = result.event((e) => this._emit(id, e));
            this._eventEmitters.set(objectId, { disposable, listenerCount: 0 });
            result = { __vscodeHandle: "eventEmitter", objectId };
          } else {
            result = { __vscodeHandle: true, objectId };
          }
        }
      }
    } catch(e) {
      error = {
        message: (e as any)?.message ?? String(e),
        stack: (e as any)?.stack,
        name: (e as any)?.name,
      };
    }

    return { result, ...(error ? { error } : {}) };
  }

  private _unregisterEvent({ objectId }: RegisterEventParams) {
    const event = this._eventEmitters.get(objectId);
    if (event && event.listenerCount > 0)
      event.listenerCount--;
  }

  private _registerEvent({ objectId }: RegisterEventParams) {
    const event = this._eventEmitters.get(objectId);
    if (event)
      event.listenerCount++;
  }

  private _release({ objectId, dispose }: ReleaseParams) {
    const obj = this._objectsById.get(objectId);
    if (obj !== undefined) {
      this._objectsById.delete(objectId);
      this._idByObjects.delete(obj);
      this._eventEmitters.get(objectId)?.disposable.dispose();
      this._eventEmitters.delete(objectId);
      if (dispose)
        obj.dispose?.();
    }
  }

  private _fromParam(param: any): any {
    if (['string', 'number', 'boolean', 'null', 'undefined'].includes(typeof param))
      return param;
    if (param.__vscodeHandle)
      return this._objectsById.get(param.objectId);
    if (Array.isArray(param))
      return param.map(v => this._fromParam(v));
    return Object.fromEntries(Object.entries(param).map(([k, v]) => [k, this._fromParam(v)]));
  }

  private _emit(objectId: number, event: any) {
    if (this._eventEmitters.get(objectId)?.listenerCount) {
      const payload: DispatchEventParams = { objectId, event };
      void this.connection.sendNotification(RPC.dispatchEvent, payload);
    }
  }
}

export async function run() {
  const server = createServer();
  const wsServer = new WebSocketServer({ server });
  try {
    await new Promise<void>((r) => server.listen(0, r));
    const address = server.address() as AddressInfo;
    process.stdout.write(
      `VSCodeTestServer listening on http://localhost:${address.port}\n`
    );
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      wsServer.once("connection", resolve);
      wsServer.once("error", reject);
    });
    const testServer = new VSCodeTestServer(ws);
    await testServer.run();
  } finally {
    wsServer.close();
    server.close();
  }
}
