/*
 * Vendored from https://github.com/ruifigueira/vscode-test-playwright (Apache-2.0).
 * Source snapshot: tmp/vscode-test-playwright @ 6c9d976 (in this repo's dev workspace).
 *
 * Local modifications:
 * - Add Electron recordVideo wiring so we can produce real videos for VS Code runs.
 */

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
import { WebSocket, WebSocketServer } from "ws";
import { VSCodeEvaluator as VSCodeEvaluatorImpl } from "./vscodeHandle";

// NOTE: Export `expect` from this module for convenience. We bind it to the
// current test instance (test.expect) later.

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

type VSCodeCommandsLike = {
  executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
};

interface VSCodeTestFixtures {
  electronApp: ElectronApplication;
  workbox: Page;
  /** Convenience wrapper for calling VS Code commands (executeCommand) from Node. */
  vscode: { commands: VSCodeCommandsLike };
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
  _rpcServer: {
    url: string;
    waitForConnection: () => Promise<WebSocket>;
  };
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

  _rpcServer: [
    async ({}, use) => {
      const sockets = new Set<WebSocket>();
      const pending: WebSocket[] = [];
      const waiters: Array<(socket: WebSocket) => void> = [];
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

      wss.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));

        const waiter = waiters.shift();
        if (waiter) {
          waiter(socket);
        } else {
          pending.push(socket);
        }
      });

      await new Promise<void>((resolve, reject) => {
        wss.once("listening", () => resolve());
        wss.once("error", (err) => reject(err));
      });

      const address = wss.address();
      if (!address || typeof address === "string") {
        throw new Error(
          "WebSocketServer did not expose a TCP address. This harness requires host+port."
        );
      }

      const url = `ws://127.0.0.1:${address.port}`;

      const waitForConnection = async (): Promise<WebSocket> => {
        const existing = pending.shift();
        if (existing) {
          return existing;
        }

        return await new Promise<WebSocket>((resolve, reject) => {
          let onSocket: ((socket: WebSocket) => void) | undefined;
          const timeout = setTimeout(() => {
            if (onSocket) {
              const idx = waiters.indexOf(onSocket);
              if (idx >= 0) {
                waiters.splice(idx, 1);
              }
            }
            reject(
              new Error(
                  "Timed out waiting for extension host WebSocket connection (PW_VSCODE_TEST_WS_URL)."
              )
            );
          }, 30_000);

          onSocket = (socket: WebSocket) => {
            clearTimeout(timeout);
            resolve(socket);

            // If this socket was already enqueued, remove it from pending.
            const idx = pending.indexOf(socket);
            if (idx >= 0) {
              pending.splice(idx, 1);
            }
          };

          waiters.push(onSocket);

          // Ensure we don't leak a waiter on timeout.
          timeout.unref?.();
        });
      };

      try {
        await use({ url, waitForConnection });
      } finally {
        for (const socket of sockets) {
          try {
            socket.close();
          } catch {
            // ignore
          }
        }

        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
    { timeout: 0, scope: "worker" },
  ],

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
            if (code === 0) {
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
        _rpcServer,
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

      // The extension host VSCodeTestServer connects back to this URL.
      env.PW_VSCODE_TEST_WS_URL = _rpcServer.url;

      // NOTE: VS Code's --extensionTestsPath must point at a JS file. We rely on `npm run compile-tests`
      // to produce `dist/` before running Playwright.
      const injectedEntryPath = path.join(
        __dirname,
        "vscodeTestServer",
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

      const resolvedExtensionsDir = extensionsDir ?? path.join(cachePath, "extensions");
      const resolvedUserDataDir = userDataDir ?? path.join(cachePath, "user-data");

      // Prevent VS Code's Git extension from blocking tests with the
      // "open repository in parent folders" notification.
      const settingsPath = path.join(resolvedUserDataDir, "User", "settings.json");
      await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.promises.writeFile(
        settingsPath,
        `${JSON.stringify(
          {
            "git.openRepositoryInParentFolders": "never",
          },
          null,
          2
        )}\n`,
        "utf8"
      );

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
          `--extensions-dir=${resolvedExtensionsDir}`,
          `--user-data-dir=${resolvedUserDataDir}`,
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
            const all = (BrowserWindow.getAllWindows?.() ?? []) as unknown[];
            return (all[0] as any) ?? null;
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
    { playwright, electronApp, vscodeTrace, _rpcServer },
    use,
    testInfo
  ) => {
    void playwright;
    void vscodeTrace;
    void testInfo;

    // The extension host entrypoint connects back to our worker-scoped WebSocket server.
    // Multiple connections are fine; for each test we use the next connection.
    void electronApp;
    const ws = await _rpcServer.waitForConnection();
    // Our current Playwright build no longer exposes the private tracing hooks
    // expected by the vendored evaluator (Tracing.onBeforeCall/onAfterCall).
    // Disable this integration; VS Code traces are still collected separately.
    const pageImpl = undefined;
    const evaluator = new VSCodeEvaluatorImpl(ws, pageImpl);
    await use(evaluator);

    try {
      ws.close();
    } catch {
      // ignore
    }
  },

  _vscodeHandle: async ({ _evaluator }, use) => {
    await use(_evaluator.rootHandle() as ObjectHandleImpl<VSCode>);
  },

  vscode: async ({ _vscodeHandle }, use) => {
    const vscode: { commands: VSCodeCommandsLike } = {
      commands: {
        executeCommand: async (command: string, ...args: unknown[]) => {
          return await _vscodeHandle.evaluate(
            (vscode, payload) =>
              vscode.commands.executeCommand(payload.command, ...payload.args),
            { command, args }
          );
        },
      },
    };

    await use(vscode);
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
    // Playwright fixture functions must use object destructuring for their first argument.
    // This fixture intentionally has no dependencies.
    // eslint-disable-next-line no-empty-pattern
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

export const expect = test.expect;
