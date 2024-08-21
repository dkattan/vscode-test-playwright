/*
 * Vendored from https://github.com/ruifigueira/vscode-test-playwright (Apache-2.0).
 * Source snapshot: tmp/vscode-test-playwright @ 6c9d976 (in this repo's dev workspace).
 */

import type * as vscode from "vscode";
import type { Disposable, EventEmitter } from "vscode";
import type { WebSocket } from "ws";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc";
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  type WsLike,
} from "./jsonRpcWsTransport";
import {
  type DispatchEventParams,
  type InvokeMethodParams,
  type InvokeMethodResult,
  type RegisterEventParams,
  type ReleaseParams,
  RPC,
} from "./rpcTypes";

export type VSCode = typeof vscode;

export type Unboxed<Arg> = Arg extends ObjectHandle<infer T>
  ? T
  : Arg extends [infer A0]
  ? [Unboxed<A0>]
  : Arg extends [infer A0, infer A1]
  ? [Unboxed<A0>, Unboxed<A1>]
  : Arg extends [infer A0, infer A1, infer A2]
  ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>]
  : Arg extends [infer A0, infer A1, infer A2, infer A3]
  ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>, Unboxed<A3>]
  : Arg extends Array<infer T>
  ? Array<Unboxed<T>>
  : Arg extends object
  ? { [Key in keyof Arg]: Unboxed<Arg[Key]> }
  : Arg;
export type VSCodeFunction0<R> = () => R | Thenable<R>;
export type VSCodeFunction<Arg, R> = (arg: Unboxed<Arg>) => R | Thenable<R>;
export type VSCodeFunctionOn<On, Arg2, R> = (
  on: On,
  arg2: Unboxed<Arg2>
) => R | Thenable<R>;

export type VSCodeHandle<T> = T extends EventEmitter<infer R>
  ? EventEmitterHandle<R>
  : ObjectHandle<T>;

export class VSCodeEvaluator {
  private readonly _ws: WebSocket;
  private readonly _connection: MessageConnection;
  private _cache = new Map<number, ObjectHandle<unknown>>();
  private _listeners = new Map<number, Set<(event: unknown) => unknown>>();
  private _page: unknown;

  constructor(ws: WebSocket, pageImpl: unknown) {
    this._ws = ws;
    this._page = pageImpl;

    const reader = new WebSocketMessageReader(ws as unknown as WsLike);
    const writer = new WebSocketMessageWriter(ws as unknown as WsLike);
    this._connection = createMessageConnection(reader, writer);

    this._connection.onNotification(
      RPC.dispatchEvent,
      ({ objectId, event }: DispatchEventParams) => {
        const listeners = this._listeners.get(objectId);
        if (!listeners) {
          return;
        }
        for (const listener of listeners) {
          listener(event);
        }
      }
    );

    this._connection.listen();

    this._cache.set(0, new ObjectHandle(0, this));
  }

  rootHandle(): ObjectHandle<VSCode> {
    return this._cache.get(0) as ObjectHandle<VSCode>;
  }

  async evaluate<R>(
    objectId: number,
    returnHandle: false,
    fn: VSCodeFunctionOn<unknown, void, R>
  ): Promise<R>;
  async evaluate<R>(
    objectId: number,
    returnHandle: true,
    fn: VSCodeFunctionOn<unknown, void, R>
  ): Promise<VSCodeHandle<R>>;
  async evaluate<R, Arg>(
    objectId: number,
    returnHandle: false,
    fn: VSCodeFunctionOn<unknown, Arg, R>,
    arg?: Arg
  ): Promise<R>;
  async evaluate<R, Arg>(
    objectId: number,
    returnHandle: true,
    fn: VSCodeFunctionOn<unknown, Arg, R>,
    arg?: Arg
  ): Promise<VSCodeHandle<R>>;
  async evaluate<R, Arg>(
    objectId: number,
    returnHandle: boolean,
    fn: VSCodeFunctionOn<unknown, Arg, R>,
    arg?: Arg
  ) {
    function toParam(input: unknown): unknown {
      if (
        input === null ||
        ["string", "number", "boolean", "undefined"].includes(typeof input)
      ) {
        return input;
      }
      if (input instanceof ObjectHandle) {
        return {
          __vscodeHandle:
            input instanceof EventEmitterHandle ? "eventEmitter" : true,
          objectId: input.objectId,
        };
      }
      if (Array.isArray(input)) {
        return input.map(toParam);
      }
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) => [
          k,
          toParam(v),
        ])
      );
    }

    const params = arg !== undefined ? [toParam(arg)] : [];
    const payload: InvokeMethodParams = {
      objectId,
      returnHandle,
      fn: fn.toString(),
      params,
    };
    const { result, error } = await this._sendAndWaitWithTrace(
      RPC.invokeMethod,
      payload
    );

    if (error) {
      const e = new Error(error.message);
      if (typeof error.stack === "string") {
        (e as Error & { stack?: string }).stack = error.stack;
      }
      throw e;
    }
    if (!returnHandle) {
      return result as R;
    }

    const handleObj = result as { __vscodeHandle: true | "eventEmitter"; objectId: number };
    let handle = this._cache.get(handleObj.objectId);
    if (!handle) {
      handle = new (
        handleObj.__vscodeHandle === "eventEmitter"
          ? EventEmitterHandle
          : ObjectHandle
      )(handleObj.objectId, this);
      this._cache.set(handleObj.objectId, handle);
    }
    return handle;
  }

  async addListener<R>(objectId: number, listener: (event: R) => unknown) {
    if (!this._cache.has(objectId)) {
      throw new Error(`No handle with id ${objectId}`);
    }
    let listeners = this._listeners.get(objectId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(objectId, listeners);
    }

    if (listeners.has(listener as unknown as (event: unknown) => unknown)) {
      return;
    }

    listeners.add(listener as unknown as (event: unknown) => unknown);
    const payload: RegisterEventParams = { objectId };
    await this._sendAndWait(RPC.registerEvent, payload);
  }

  async removeListener<R>(objectId: number, listener: (event: R) => unknown) {
    const listeners = this._listeners.get(objectId);
    const l = listener as unknown as (event: unknown) => unknown;
    if (!listeners?.has(l)) {
      return;
    }
    listeners.delete(l);
    const payload: RegisterEventParams = { objectId };
    await this._sendAndWait(RPC.unregisterEvent, payload);
  }

  async release(objectId: number, options?: { dispose?: boolean }) {
    this._listeners.delete(objectId);
    if (!this._cache.delete(objectId)) {
      return;
    }
    const payload: ReleaseParams = { objectId, ...options };
    await this._sendAndWaitWithTrace(RPC.release, payload);
  }

  async dispose() {
    await Promise.all(
      [...this._cache.keys()].map((objectId) => this.release(objectId))
    ).catch(() => {});
    this._connection.dispose();
    this._ws.removeAllListeners("message");
  }

  private async _sendAndWait(
    method: typeof RPC.release | typeof RPC.registerEvent | typeof RPC.unregisterEvent,
    params: ReleaseParams | RegisterEventParams
  ): Promise<void> {
    await this._connection.sendRequest(method, params);
  }

  private async _sendAndWaitWithTrace(
    method: typeof RPC.invokeMethod,
    params: InvokeMethodParams
  ): Promise<InvokeMethodResult>;
  private async _sendAndWaitWithTrace(
    method: typeof RPC.release,
    params: ReleaseParams
  ): Promise<void>;
  private async _sendAndWaitWithTrace(
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (!this._page) {
      return await this._connection.sendRequest(method, params);
    }

    // eslint-disable-next-line ts/no-require-imports
    const { monotonicTime, createGuid } = require("playwright-core/lib/utils");

    interface FrameLike {
      guid: string;
    }

    interface TracingLike {
      onBeforeCall: (frame: FrameLike, metadata: unknown) => Promise<void>;
      onAfterCall: (
        frame: FrameLike,
        metadata: unknown
      ) => Promise<void>;
    }

    interface PageLike {
      context: () => { tracing: TracingLike };
      mainFrame: () => FrameLike;
      guid: string;
    }

    const page = this._page as PageLike;
    const tracing = page.context().tracing;
    const frame = page.mainFrame();
    const metadata = {
      id: `vscodecall@${createGuid()}`,
      startTime: monotonicTime(),
      endTime: 0,
      // prevents pause action from being written into calllogs
      internal: false,
      objectId: frame.guid,
      pageId: page.guid,
      frameId: frame.guid,
      type: "vscodeHandle",
      method,
      params: { method, params },
      log: [] as string[],
    };
    await tracing.onBeforeCall(frame, metadata);
    let error: unknown;
    let result: unknown;
    try {
      result = await this._connection.sendRequest(method, params);
      return result;
    } catch (e: unknown) {
      const err = e as { message?: string; stack?: string; name?: string };
      error = {
        error: {
          message: err?.message ?? String(e),
          stack: err?.stack,
          name: err?.name,
        },
      };
      throw e;
    } finally {
      await tracing.onAfterCall(frame, {
        ...metadata,
        endTime: monotonicTime(),
        error,
        result,
      });
    }
  }
}

export class ObjectHandle<T = VSCode> {
  readonly objectId: number;
  protected _evaluator: VSCodeEvaluator;
  private _released = false;

  constructor(objectId: number, evaluator: VSCodeEvaluator) {
    this.objectId = objectId;
    this._evaluator = evaluator;
  }

  evaluate<R>(vscodeFunction: VSCodeFunctionOn<T, void, R>): Promise<R>;
  evaluate<R, Arg>(
    vscodeFunction: VSCodeFunctionOn<T, Arg, R>,
    arg: Arg
  ): Promise<R>;
  evaluate<R, Arg>(
    vscodeFunction: VSCodeFunctionOn<T, Arg, R>,
    arg?: Arg
  ): Promise<R> {
    if (this._released) {
      throw new Error("Handle is released");
    }
    return this._evaluator.evaluate(
      this.objectId,
      false,
      vscodeFunction as unknown as VSCodeFunctionOn<unknown, Arg, R>,
      arg
    );
  }

  evaluateHandle<R>(
    vscodeFunction: VSCodeFunctionOn<T, void, R>
  ): Promise<VSCodeHandle<R>>;
  evaluateHandle<R, Arg>(
    vscodeFunction: VSCodeFunctionOn<T, Arg, R>,
    arg: Arg
  ): Promise<VSCodeHandle<R>>;
  evaluateHandle<R, Arg>(
    vscodeFunction: VSCodeFunctionOn<T, Arg, R>,
    arg?: Arg
  ): Promise<VSCodeHandle<R>> {
    if (this._released) {
      throw new Error("Handle is released");
    }
    return this._evaluator.evaluate(
      this.objectId,
      true,
      vscodeFunction as unknown as VSCodeFunctionOn<unknown, Arg, R>,
      arg
    );
  }

  release<O extends T extends Disposable ? { dispose: boolean } : Record<string, never>>(
    options?: O
  ): Promise<void>;
  async release(options?: { dispose?: boolean }) {
    this._released = true;
    await this._evaluator.release(this.objectId, options);
  }
}

export class EventEmitterHandle<R> extends ObjectHandle<EventEmitter<R>> {
  constructor(objectId: number, evaluator: VSCodeEvaluator) {
    super(objectId, evaluator);
  }

  async addListener(e: (event: R) => unknown) {
    await this._evaluator.addListener(this.objectId, e);
  }

  async removeListener(e: (event: R) => unknown) {
    await this._evaluator.removeListener(this.objectId, e);
  }
}
