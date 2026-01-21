import type * as vscode from 'vscode';
import type { EventEmitter, Disposable } from 'vscode';
import {
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc';
import { WebSocket } from 'ws';
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
  type WsLike,
} from './jsonRpcWsTransport';
import {
  type DispatchEventParams,
  type InvokeMethodParams,
  type InvokeMethodResult,
  type RegisterEventParams,
  type ReleaseParams,
  RPC,
} from './rpcTypes';

export type VSCode = typeof vscode;

type VSCodeHandleObject =
  | { __vscodeHandle: true; objectId: number }
  | { __vscodeHandle: 'eventEmitter'; objectId: number };

export type Unboxed<Arg> =
  Arg extends ObjectHandle<infer T> ? T :
  Arg extends [infer A0] ? [Unboxed<A0>] :
  Arg extends [infer A0, infer A1] ? [Unboxed<A0>, Unboxed<A1>] :
  Arg extends [infer A0, infer A1, infer A2] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>] :
  Arg extends [infer A0, infer A1, infer A2, infer A3] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>, Unboxed<A3>] :
  Arg extends Array<infer T> ? Array<Unboxed<T>> :
  Arg extends object ? { [Key in keyof Arg]: Unboxed<Arg[Key]> } :
  Arg;
export type VSCodeFunction0<R> = () => R | Thenable<R>;
export type VSCodeFunction<Arg, R> = (arg: Unboxed<Arg>) => R | Thenable<R>;
export type VSCodeFunctionOn<On, Arg2, R> = (on: On, arg2: Unboxed<Arg2>) => R | Thenable<R>;

export type VSCodeHandle<T> = T extends EventEmitter<infer R> ? EventEmitterHandle<R> : ObjectHandle<T>;

export class VSCodeEvaluator {
  private _ws: WebSocket;
  private readonly _connection: MessageConnection;
  private _cache = new Map<number, ObjectHandle<unknown>>();
  private _listeners = new Map<number, Set<((event?: any) => any)>>();
  private _page: any;

  constructor(ws: WebSocket, pageImpl: any) {
    this._ws = ws;
    this._page = pageImpl;

    const reader = new WebSocketMessageReader(ws as unknown as WsLike);
    const writer = new WebSocketMessageWriter(ws as unknown as WsLike);
    this._connection = createMessageConnection(reader, writer);

    this._connection.onNotification(
      RPC.dispatchEvent,
      (p: DispatchEventParams) => {
        const { objectId, event } = p;
        const listeners = this._listeners.get(objectId);
        if (listeners) {
          for (const listener of listeners) {
            listener(event);
          }
        }
      }
    );

    this._connection.listen();

    this._cache.set(0, new ObjectHandle(0, this));
  }

  rootHandle(): ObjectHandle<VSCode> {
    return this._cache.get(0) as ObjectHandle<VSCode>;
  }

  async evaluate<R>(objectId: number, returnHandle: false, fn: VSCodeFunctionOn<any, void, R>): Promise<R>;
  async evaluate<R>(objectId: number, returnHandle: true, fn: VSCodeFunctionOn<any, void, R>): Promise<VSCodeHandle<R>>;
  async evaluate<R, Arg>(objectId: number, returnHandle: false, fn: VSCodeFunctionOn<any, Arg, R>, arg?: Arg): Promise<R>;
  async evaluate<R, Arg>(objectId: number, returnHandle: true, fn: VSCodeFunctionOn<any, Arg, R>, arg?: Arg): Promise<VSCodeHandle<R>>;
  async evaluate<R, Arg>(objectId: number, returnHandle: boolean, fn: VSCodeFunctionOn<any, Arg, R>, arg?: Arg) {
    function toParam(arg: any): any {
      if (['string', 'number', 'boolean', 'null', 'undefined'].includes(typeof arg))
        return arg;
      if (arg instanceof ObjectHandle)
        return { __vscodeHandle: arg instanceof EventEmitterHandle ? 'eventEmitter' : true, objectId: arg.objectId };
      if (Array.isArray(arg))
        return arg.map(toParam);
      return Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, toParam(v)]));
    }

    const params = arg !== undefined ? [toParam(arg)] : [];
    const response = await this._sendRequestWithTrace<InvokeMethodParams, InvokeMethodResult>(
      RPC.invokeMethod,
      { objectId, returnHandle, fn: fn.toString(), params }
    );
    if (response.error) {
      const e = new Error(response.error.message);
      (e as any).name = response.error.name ?? e.name;
      if (response.error.stack)
        e.stack = response.error.stack;
      throw e;
    }

    const { result } = response;
    if (!returnHandle)
      return result;

    const handleObj = result as VSCodeHandleObject;
    let handle = this._cache.get(handleObj.objectId);
    if (!handle) {
      handle = new (handleObj.__vscodeHandle === 'eventEmitter' ? EventEmitterHandle : ObjectHandle)(handleObj.objectId, this);
      this._cache.set(handleObj.objectId, handle);
    }
    return handle;
  }

  async addListener<R>(objectId: number, listener: (event: R) => any) {
    if (!this._cache.has(objectId))
      throw new Error(`No handle with id ${objectId}`);
    let listeners = this._listeners.get(objectId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(objectId, listeners);
    }

    if (listeners.has(listener))
      return;

    listeners.add(listener);
    await this._sendRequest<RegisterEventParams, void>(RPC.registerEvent, { objectId });
  }

  async removeListener<R>(objectId: number, listener: (event: R) => any) {
    const listeners = this._listeners.get(objectId);
    if (!listeners?.has(listener))
      return
    listeners.delete(listener);
    await this._sendRequest<RegisterEventParams, void>(RPC.unregisterEvent, { objectId });
  }

  async release(objectId: number, options?: { dispose?: boolean }) {
    this._listeners.delete(objectId);
    if (!this._cache.delete(objectId))
      return;
    await this._sendRequestWithTrace<ReleaseParams, void>(RPC.release, { objectId, ...options });
  }

  async dispose() {
    await Promise.all([...this._cache.keys()].map(objectId => this.release(objectId))).catch(() => { });
    this._connection.dispose();
  }

  private async _sendRequest<TParams, TResult>(
    method: string,
    params: TParams
  ): Promise<TResult> {
    // Avoid hanging forever: if the socket is not open, fail immediately.
    if (this._ws.readyState !== this._ws.OPEN) {
      throw new Error(
        `Cannot send '${String(method)}' to VS Code test server: websocket not open (readyState=${this._ws.readyState})`
      );
    }

    return (await this._connection.sendRequest(method, params as any)) as TResult;
  }

  private async _sendRequestWithTrace<TParams, TResult>(
    method: string,
    params: TParams
  ): Promise<TResult> {
    if (!this._page)
      return await this._sendRequest<TParams, TResult>(method, params);

    const getGuid = (obj: any): string | undefined => {
      // Different Playwright objects expose guid differently across layers/versions.
      return obj?.guid ?? obj?._guid ?? obj?._object?._guid;
    };

    // If we're not dealing with a client-side Page object that has the tracing
    // instrumentation hooks, fall back to a normal send (no custom call log).
    const tracing = this._page?.context?.()?.tracing;
    const frame = this._page?.mainFrame?.();
    if (!tracing || !frame || typeof tracing.onBeforeCall !== 'function' || typeof tracing.onAfterCall !== 'function')
      return await this._sendRequest<TParams, TResult>(method, params);

    const { monotonicTime, createGuid } = require('playwright-core/lib/utils');
    const frameGuid = getGuid(frame);
    const pageGuid = getGuid(this._page);
    const traceMethod =
      method === RPC.invokeMethod && (params as any)?.returnHandle
        ? 'evaluateHandle'
        : method === RPC.invokeMethod
          ? 'evaluate'
          : String(method);
    const metadata = {
      id: `vscodecall@${createGuid()}`,
      startTime: monotonicTime(),
      endTime: 0,
      // prevents pause action from being written into calllogs
      internal: false,
      objectId: frameGuid,
      pageId: pageGuid,
      frameId: frameGuid,
      type: 'vscodeHandle',
      method: traceMethod,
      params: { method, params },
      log: [] as string[],
    };
    await tracing.onBeforeCall(frame, metadata);
    let error: any, result: any;
    try {
      result = await this._sendRequest<TParams, TResult>(method, params);
      return result;
    } catch (e) {
      const err = e as any;
      error = {
        error: {
          message: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name,
        },
      };
      throw err;
    } finally {
      await tracing.onAfterCall(frame, { ...metadata, endTime: monotonicTime(), error, result });
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
  evaluate<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg: Arg): Promise<R>;
  evaluate<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg?: Arg): Promise<R> {
    if (this._released)
      throw new Error(`Handle is released`);
    return this._evaluator.evaluate(this.objectId, false, vscodeFunction, arg);
  }

  evaluateHandle<R>(vscodeFunction: VSCodeFunctionOn<T, void, R>): Promise<VSCodeHandle<R>>;
  evaluateHandle<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg: Arg): Promise<VSCodeHandle<R>>;
  evaluateHandle<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg?: Arg): Promise<VSCodeHandle<R>> {
    if (this._released)
      throw new Error(`Handle is released`);
    return this._evaluator.evaluate(this.objectId, true, vscodeFunction, arg);
  }

  release<O extends (T extends Disposable ? { dispose: boolean } : {})>(options?: O): Promise<void>;
  async release(options?: { dispose?: boolean }) {
    this._released = true;
    await this._evaluator.release(this.objectId, options);
  }
}

export class EventEmitterHandle<R> extends ObjectHandle<EventEmitter<R>> {

  constructor(objectId: number, evaluator: VSCodeEvaluator) {
    super(objectId, evaluator);
  }

  async addListener(e: (event: R) => any) {
    await this._evaluator.addListener(this.objectId, e);
  }

  async removeListener(e: (event: R) => any) {
    await this._evaluator.removeListener(this.objectId, e);
  }
}
