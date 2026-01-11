/*
 * Vendored from https://github.com/ruifigueira/vscode-test-playwright (Apache-2.0).
 * Source snapshot: tmp/vscode-test-playwright @ 6c9d976 (in this repo's dev workspace).
 *
 * Local modifications:
 * - Add Electron recordVideo wiring so we can produce real videos for VS Code runs.
 */

import type { BrowserWindow } from "electron";
import type { EventEmitter } from "node:events";
import type {
  ObjectHandle,
  ObjectHandle as ObjectHandleImpl,
  VSCode,
  VSCodeEvaluator,
  VSCodeFunctionOn,
  VSCodeHandle,
} from "./vscodeHandle";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import * as readline from "node:readline";
import {
  _electron,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo,
  type TraceMode,
} from "@playwright/test";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { WebSocket } from "ws";
import { VSCodeEvaluator as VSCodeEvaluatorImpl } from "./vscodeHandle";

export { expect } from "@playwright/test";

export type VSCodeVideoMode = "off" | "on" | "retain-on-failure";

export interface VSCodeVideoOptions {
  mode: VSCodeVideoMode;
  /** The output video dimensions (Playwright Electron recordVideo size). */
  size?: { width: number; height: number };
  /** The VS Code (Electron/Chromium) window size. If set and `size` is omitted, `size` will default to this value. */
  windowSize?: { width: number; height: number };
}

export interface VSCodeWorkerOptions {
  vscodeVersion: string;
  extensions?: string | string[];
  vscodeTrace:
    | TraceMode
    | {
        mode: TraceMode;
        snapshots?: boolean;
        screenshots?: boolean;
        sources?: boolean;
        attachments?: boolean;
      };
  extensionsDir?: string;
  userDataDir?: string;
  /** Enable Playwright Electron recordVideo for the VS Code process. */
  vscodeVideo?: VSCodeVideoOptions | VSCodeVideoMode;
}

export interface VSCodeTestOptions {
  extensionDevelopmentPath?: string;
  baseDir: string;
}

interface VSCodeTestFixtures {
  electronApp: ElectronApplication;
  workbox: Page;
  evaluateInVSCode: (<R>(
    vscodeFunction: VSCodeFunctionOn<VSCode, void, R>
  ) => Promise<R>) &
    (<R, Arg>(
      vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>,
      arg: Arg
    ) => Promise<R>);
  evaluateHandleInVSCode: (<R>(
    vscodeFunction: VSCodeFunctionOn<VSCode, void, R>
  ) => Promise<VSCodeHandle<R>>) &
    (<R, Arg>(
      vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>,
      arg: Arg
    ) => Promise<VSCodeHandle<R>>);
}

interface ExperimentalVSCodeTestFixtures {
  _enableRecorder: void;
}

interface InternalWorkerFixtures {
  _createTempDir: () => Promise<string>;
  _vscodeInstall: { installPath: string; cachePath: string };
}

interface InternalTestFixtures {
  _evaluator: VSCodeEvaluator;
  _vscodeHandle: ObjectHandle<VSCode>;
}

function shouldCaptureTrace(traceMode: TraceMode, testInfo: TestInfo) {
  if (process.env.PW_TEST_DISABLE_TRACING) {
    return false;
  }

  if (traceMode === "on") {
    return true;
  }

  if (traceMode === "retain-on-failure") {
    return true;
  }

  if (traceMode === "on-first-retry" && testInfo.retry === 1) {
    return true;
  }

  if (traceMode === "on-all-retries" && testInfo.retry > 0) {
    return true;
  }

  if (traceMode === "retain-on-first-failure" && testInfo.retry === 0) {
    return true;
  }

  return false;
}

function getTraceMode(
  trace:
    | TraceMode
    | "retry-with-trace"
    | {
        mode: TraceMode;
        snapshots?: boolean;
        screenshots?: boolean;
        sources?: boolean;
        attachments?: boolean;
      }
) {
  const traceMode = typeof trace === "string" ? trace : trace.mode;
  if (traceMode === "retry-with-trace") {
    return "on-first-retry";
  }
  return traceMode;
}

function normalizeVideoOptions(
  video: VSCodeWorkerOptions["vscodeVideo"]
): VSCodeVideoOptions {
  if (!video) {
    return { mode: "off" };
  }
  if (typeof video === "string") {
    return { mode: video };
  }
  return video;
}

function toEven(n: number) {
  // Some encoders/players behave better with even dimensions.
  return n % 2 === 0 ? n : n - 1;
}

// adapted from https://github.com/microsoft/playwright/blob/a6b320e36224f70ad04fd520503c230d5956ba66/packages/playwright-core/src/server/electron/electron.ts#L294-L320
function waitForLine(
  process: cp.ChildProcess,
  regex: RegExp
): Promise<RegExpMatchArray> {
  function addEventListener<Args extends unknown[]>(
    emitter: EventEmitter,
    eventName: string | symbol,
    handler: (...args: Args) => void
  ) {
    emitter.on(eventName, handler);
    return { emitter, eventName, handler };
  }

  function removeEventListeners(
    listeners: Array<{
      emitter: EventEmitter;
      eventName: string | symbol;
      handler: (...args: unknown[]) => void;
    }>
  ) {
    for (const listener of listeners) {
      listener.emitter.removeListener(listener.eventName, listener.handler);
    }
    listeners.splice(0, listeners.length);
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stderr! });
    const failError = new Error("Process failed to launch!");
    const listeners = [
      addEventListener(rl, "line", onLine),
      addEventListener(rl, "close", reject.bind(null, failError)),
      addEventListener(process, "exit", reject.bind(null, failError)),
      // It is Ok to remove error handler because we did not create process and there is another listener.
      addEventListener(process, "error", reject.bind(null, failError)),
    ];

    function onLine(...args: unknown[]) {
      const line = args[0];
      if (typeof line !== "string") {
        return;
      }

      const match = line.match(regex);
      if (!match) {
        return;
      }
      cleanup();
      resolve(match);
    }

    function cleanup() {
      removeEventListeners(listeners);
    }
  });
}

export const test = base.extend<
  VSCodeTestFixtures &
    VSCodeTestOptions &
    InternalTestFixtures &
    ExperimentalVSCodeTestFixtures,
  VSCodeWorkerOptions & InternalWorkerFixtures
>({
  vscodeVersion: ["insiders", { option: true, scope: "worker" }],
  extensions: [undefined, { option: true, scope: "worker" }],
  vscodeTrace: ["off", { option: true, scope: "worker" }],
  vscodeVideo: ["off", { option: true, scope: "worker" }],
  extensionDevelopmentPath: [undefined, { option: true }],
  baseDir: [
    async ({ _createTempDir }, use) => await use(await _createTempDir()),
    { option: true },
  ],
  extensionsDir: [undefined, { option: true, scope: "worker" }],
  userDataDir: [undefined, { option: true, scope: "worker" }],

  _vscodeInstall: [
    async (
      { _createTempDir, vscodeVersion, extensions, extensionsDir, userDataDir },
      use,
      workerInfo
    ) => {
      const cachePath = await _createTempDir();
      const installBasePath = path.join(
        process.cwd(),
        ".vscode-test",
        `worker-${workerInfo.parallelIndex}`
      );
      await fs.promises.mkdir(installBasePath, { recursive: true });
      const installPath = await downloadAndUnzipVSCode({
        cachePath: installBasePath,
        version: vscodeVersion,
      });
      const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(installPath);

      if (extensions) {
        await new Promise<void>((resolve, reject) => {
          const list =
            typeof extensions === "string" ? [extensions] : extensions ?? [];
          const subProcess = cp.spawn(
            cliPath,
            [
              `--extensions-dir=${
                extensionsDir ?? path.join(cachePath, "extensions")
              }`,
              `--user-data-dir=${
                userDataDir ?? path.join(cachePath, "user-data")
              }`,
              ...list.flatMap((extension) => [
                "--install-extension",
                extension,
              ]),
            ],
            {
              stdio: "inherit",
              shell: os.platform() === "win32",
            }
          );
          subProcess.on("exit", (code, signal) => {
            if (!code) {
              resolve();
            } else {
              reject(
                new Error(
                  `Failed to install extensions: code = ${code}, signal = ${signal}`
                )
              );
            }
          });
        });
      }

      await use({ installPath, cachePath });
    },
    { timeout: 0, scope: "worker" },
  ],

  // based on https://github.com/microsoft/playwright-vscode/blob/1d855b9a7aeca783223a7a9f8e3b01efbe8e16f2/tests-integration/tests/baseTest.ts
  electronApp: [
    async (
      {
        extensionDevelopmentPath,
        baseDir,
        _vscodeInstall,
        vscodeTrace,
        trace,
        extensionsDir,
        userDataDir,
        vscodeVideo,
      },
      use,
      testInfo
    ) => {
      const { installPath, cachePath } = _vscodeInstall;

      // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
      // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
      const env = { ...process.env } as Record<string, string>;
      for (const prop in env) {
        if (/^VSCODE_/i.test(prop)) {
          delete env[prop];
        }
      }

      // NOTE: VS Code's --extensionTestsPath must point at a JS file. We rely on `npm run compile-tests`
      // to produce `out/` before running Playwright.
      const injectedEntryPath = path.join(
        process.cwd(),
        "out",
        "vendor",
        "vscode-test-playwright",
        "injected",
        "index.js"
      );

      const videoOptions = normalizeVideoOptions(vscodeVideo);
      const shouldRecordVideo = videoOptions.mode !== "off";
      const videoDir = testInfo.outputPath("videos");
      if (shouldRecordVideo) {
        await fs.promises.mkdir(videoDir, { recursive: true });
      }

      const requestedWindowSize = videoOptions.windowSize;
      const requestedVideoSize = videoOptions.size ?? videoOptions.windowSize;
      const normalizedVideoSize = requestedVideoSize
        ? {
            width: toEven(requestedVideoSize.width),
            height: toEven(requestedVideoSize.height),
          }
        : undefined;

      const electronApp = await _electron.launch({
        executablePath: installPath,
        env,
        ...(shouldRecordVideo
          ? {
              recordVideo: {
                dir: videoDir,
                ...(normalizedVideoSize ? { size: normalizedVideoSize } : {}),
              },
            }
          : {}),
        args: [
          // Stolen from https://github.com/microsoft/vscode-test/blob/0ec222ef170e102244569064a12898fb203e5bb7/lib/runTest.ts#L126-L160
          // https://github.com/microsoft/vscode/issues/84238
          "--no-sandbox",
          // https://github.com/microsoft/vscode-test/issues/221
          "--disable-gpu-sandbox",
          // https://github.com/microsoft/vscode-test/issues/120
          "--disable-updates",
          "--skip-welcome",
          "--skip-release-notes",
          "--disable-workspace-trust",
          ...(requestedWindowSize
            ? [
                // Best-effort hint; VS Code/Electron may ignore this.
                `--window-size=${requestedWindowSize.width},${requestedWindowSize.height}`,
                // Avoid retina scaling making the pixel dimensions diverge.
                "--force-device-scale-factor=1",
              ]
            : []),
          `--extensions-dir=${
            extensionsDir ?? path.join(cachePath, "extensions")
          }`,
          `--user-data-dir=${userDataDir ?? path.join(cachePath, "user-data")}`,
          `--extensionTestsPath=${injectedEntryPath}`,
          ...(extensionDevelopmentPath
            ? [`--extensionDevelopmentPath=${extensionDevelopmentPath}`]
            : []),
          baseDir,
        ],
      });

      // VS Code may ignore Chromium-style --window-size. To make `windowSize` reliable,
      // resize the first BrowserWindow after launch.
      if (requestedWindowSize) {
        await electronApp.evaluate(async ({ BrowserWindow }, size) => {
          const deadline = Date.now() + 5_000;

          function tryGetFirstWindow() {
            const all = BrowserWindow.getAllWindows() as BrowserWindow[];
            return all[0] ?? null;
          }

          // Wait for the first VS Code window to actually exist.
          let win = tryGetFirstWindow();
          while (!win && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
            win = tryGetFirstWindow();
          }
          if (!win) {
            return;
          }

          if (win.isMaximized()) {
            win.unmaximize();
          }
          if (win.isFullScreen()) {
            win.setFullScreen(false);
          }

          // Use content size so the recorded video matches what you see in the workbench.
          // NOTE: Intentionally no alternate path here — we want to know which API actually works.
          win.setContentSize(size.width, size.height);
          win.center();
        }, requestedWindowSize);
      }

      const traceMode = getTraceMode(vscodeTrace);
      const captureTrace = shouldCaptureTrace(traceMode, testInfo);
      const context = electronApp.context();
      if (captureTrace) {
        const { screenshots, snapshots } =
          typeof vscodeTrace !== "string"
            ? vscodeTrace
            : { screenshots: true, snapshots: true };
        await context.tracing.start({
          screenshots,
          snapshots,
          title: testInfo.title,
        });
      }

      await use(electronApp);

      if (captureTrace) {
        const testFailed = testInfo.status !== testInfo.expectedStatus;
        const shouldAbandonTrace =
          !testFailed &&
          (traceMode === "retain-on-failure" ||
            traceMode === "retain-on-first-failure");
        if (!shouldAbandonTrace) {
          // if default trace is not off, use vscode-trace to avoid conflicts
          const traceName =
            getTraceMode(trace) === "off" ? "trace" : "vscode-trace";
          const tracePath = testInfo.outputPath(`${traceName}.zip`);
          await context.tracing.stop({ path: tracePath });
          testInfo.attachments.push({
            name: traceName,
            path: tracePath,
            contentType: "application/zip",
          });
        }
      }

      await electronApp.close();

      // If requested, delete videos from successful runs.
      if (shouldRecordVideo && videoOptions.mode === "retain-on-failure") {
        const testFailed = testInfo.status !== testInfo.expectedStatus;
        if (!testFailed) {
          await fs.promises.rm(videoDir, { recursive: true, force: true });
        }
      }

      const logPath = path.join(cachePath, "user-data", "logs");
      if (fs.existsSync(logPath)) {
        const logOutputPath = test.info().outputPath("vscode-logs");
        await fs.promises.cp(logPath, logOutputPath, { recursive: true });
      }
    },
    { timeout: 0 },
  ],

  workbox: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow());
  },

  page: ({ workbox }, use) => use(workbox),

  context: ({ electronApp }, use) => use(electronApp.context()),

  _evaluator: async (
    { playwright, electronApp, vscodeTrace },
    use,
    testInfo
  ) => {
    interface ElectronAppImplLike {
      _process: cp.ChildProcess;
      _nodeConnection: {
        _browserLogsCollector: {
          recentLogs: () => string[];
        };
      };
    }

    // Playwright no longer exposes `playwright._toImpl` in newer versions.
    // Use the ChannelOwner connection helper instead.
    void playwright;
    const toImplUnknown = (electronApp as unknown as { _connection?: { toImpl?: unknown } })
      ._connection?.toImpl;
    if (typeof toImplUnknown !== "function") {
      throw new Error(
        "Expected electronApp._connection.toImpl to be a function (Playwright internal API changed)."
      );
    }
    const toImpl = toImplUnknown as <T>(obj: T) => unknown;

    const electronAppImpl =
      (await Promise.resolve(toImpl(electronApp))) as ElectronAppImplLike;
    // check recent logs or wait for URL to access VSCode test server
    const vscodeTestServerRegExp =
      /^VSCodeTestServer listening on (http:\/\/.*)$/;
    const process = electronAppImpl._process as cp.ChildProcess;
    const recentLogs =
      electronAppImpl._nodeConnection._browserLogsCollector.recentLogs() as string[];
    const matches = recentLogs
      .map((s) => s.match(vscodeTestServerRegExp))
      .filter((m): m is RegExpMatchArray => m !== null);
    let match = matches[0];
    if (!match) {
      match = await waitForLine(process, vscodeTestServerRegExp);
    }

    const ws = new WebSocket(match[1]);
    await new Promise((r) => ws.once("open", r));
    // Our current Playwright build no longer exposes the private tracing hooks
    // expected by the vendored evaluator (Tracing.onBeforeCall/onAfterCall).
    // Disable this integration; VS Code traces are still collected separately.
    void vscodeTrace;
    void testInfo;
    const pageImpl = undefined;
    const evaluator = new VSCodeEvaluatorImpl(ws, pageImpl);
    await use(evaluator);
    ws.close();
  },

  _vscodeHandle: async ({ _evaluator }, use) => {
    await use(_evaluator.rootHandle() as ObjectHandleImpl<VSCode>);
  },

  evaluateInVSCode: async ({ _vscodeHandle }, use) => {
    const evaluate: VSCodeTestFixtures["evaluateInVSCode"] = (<R, Arg>(
      fn: VSCodeFunctionOn<VSCode, Arg, R>,
      arg?: Arg
    ) => {
      if (arg === undefined) {
        return _vscodeHandle.evaluate(
          fn as unknown as VSCodeFunctionOn<VSCode, void, R>
        );
      }
      return _vscodeHandle.evaluate(fn, arg);
    }) as VSCodeTestFixtures["evaluateInVSCode"];

    await use(evaluate);
  },

  evaluateHandleInVSCode: async ({ _vscodeHandle }, use) => {
    const handles: ObjectHandleImpl<unknown>[] = [];
    function evaluateHandle<R>(
      vscodeFunction: VSCodeFunctionOn<VSCode, void, R>
    ): Promise<VSCodeHandle<R>>;
    function evaluateHandle<R, Arg>(
      vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>,
      arg: Arg
    ): Promise<VSCodeHandle<R>>;
    async function evaluateHandle<R, Arg>(
      vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>,
      arg?: Arg
    ): Promise<VSCodeHandle<R>> {
      const handle =
        arg === undefined
          ? await _vscodeHandle.evaluateHandle(
              vscodeFunction as unknown as VSCodeFunctionOn<VSCode, void, R>
            )
          : await _vscodeHandle.evaluateHandle(vscodeFunction, arg);
      handles.push(handle as unknown as ObjectHandleImpl<unknown>);
      return handle;
    }

    await use(evaluateHandle);
    await Promise.all(handles.map((h) => h.release()));
  },

  _createTempDir: [
    async ({}, use) => {
      const tempDirs: string[] = [];
      await use(async () => {
        const tempDir = await fs.promises.realpath(
          await fs.promises.mkdtemp(path.join(os.tmpdir(), "pwtest-"))
        );
        await fs.promises.mkdir(tempDir, { recursive: true });
        tempDirs.push(tempDir);
        return tempDir;
      });
      for (const tempDir of tempDirs) {
        await fs.promises.rm(tempDir, { recursive: true });
      }
    },
    { scope: "worker" },
  ],

  _enableRecorder: [
    async ({ playwright, context }, use) => {
      const skip = !!process.env.CI;
      let closePromise: Promise<void> | undefined;
      if (!skip) {
        interface ContextWithRecorder {
          _enableRecorder: (options: {
            language: string;
            mode: string;
          }) => Promise<void>;
        }

        await (context as unknown as ContextWithRecorder)._enableRecorder({
          language: "playwright-test",
          mode: "recording",
        });
        interface PlaywrightToImpl {
          _toImpl: <T>(obj: T) => Promise<unknown>;
        }
        interface ContextImplWithRecorderApp {
          recorderAppForTest: {
            once: (event: "close", cb: () => void) => void;
          };
        }
        const toImpl = (playwright as unknown as PlaywrightToImpl)._toImpl;
        const contextImpl = (await toImpl(
          context
        )) as ContextImplWithRecorderApp;
        closePromise = new Promise((resolve) =>
          contextImpl.recorderAppForTest.once("close", resolve)
        );
      }
      await use();
      if (closePromise) {
        await closePromise;
      }
    },
    { timeout: 0 },
  ],
});
