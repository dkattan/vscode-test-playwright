/*
 * JSON-RPC payload types used between the harness (Playwright runner) and the VS Code extension host entrypoint.
 */

export const RPC = {
  invokeMethod: "invokeMethod",
  release: "release",
  registerEvent: "registerEvent",
  unregisterEvent: "unregisterEvent",
  dispatchEvent: "dispatchEvent",
} as const;

export interface InvokeMethodParams {
  objectId: number;
  returnHandle: boolean;
  fn: string;
  params: unknown[];
}

export interface InvokeMethodResult {
  result: unknown;
  error?: { message: string; stack?: string; name?: string };
}

export interface ReleaseParams {
  objectId: number;
  dispose?: boolean;
}

export interface RegisterEventParams {
  objectId: number;
}

export interface DispatchEventParams {
  objectId: number;
  event: unknown;
}
