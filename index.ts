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
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
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
import { closeRpcTransport, type RpcTransport } from "./rpcTransport";

function isHarnessTraceEnabled(): boolean {
  const raw = process.env.PW_VSCODE_TEST_TRACE;
  if (!raw) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

let harnessTraceSink: ((line: string) => void) | undefined;
const harnessTraceBuffer: string[] = [];
const HARNESS_TRACE_BUFFER_MAX_LINES = 2_000;

function setHarnessTraceFile(filePath: string) {
  // Lazily initialize so worker-scoped fixtures can emit trace lines early.
  // Once the test-scoped output path exists, we flush the in-memory buffer.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  harnessTraceSink = (line: string) => {
    try {
      fs.appendFileSync(filePath, line, "utf8");
    } catch {
      // ignore
    }
  };

  while (harnessTraceBuffer.length) {
    harnessTraceSink(harnessTraceBuffer.shift()!);
  }
}

function harnessTrace(message: string) {
  if (!isHarnessTraceEnabled()) {
    return;
  }

  const line = `[pw-vscode-test][${new Date().toISOString()}][pid=${process.pid}] ${message}\n`;

  // Always emit to stderr so CI logs capture it even if artifacts aren't uploaded.
  try {
    process.stderr.write(line);
  } catch {
    // ignore
  }

  if (harnessTraceSink) {
    harnessTraceSink(line);
    return;
  }

  // Buffer early lines until the test-scoped output path is known.
  harnessTraceBuffer.push(line);
  if (harnessTraceBuffer.length > HARNESS_TRACE_BUFFER_MAX_LINES) {
    harnessTraceBuffer.splice(0, harnessTraceBuffer.length - HARNESS_TRACE_BUFFER_MAX_LINES);
  }
}

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
  _rpcServer:
    | {
        transport: "ws";
        url: string;
        waitForConnection: () => Promise<RpcTransport>;
      }
    | {
        transport: "pipe";
        pipePath: string;
        waitForConnection: () => Promise<RpcTransport>;
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

async function waitForWebmVideoToFinalize(options: {
  videoDir: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<string | undefined> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;

  let candidate: string | undefined;
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() < deadline) {
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(options.videoDir);
    } catch {
      // If the directory isn't readable yet, keep waiting.
    }

    const webms = entries
      .filter((e) => e.toLowerCase().endsWith(".webm"))
      .map((e) => path.join(options.videoDir, e));

    if (webms.length > 0) {
      candidate = webms[0];
      try {
        const st = await fs.promises.stat(candidate);
        if (st.size > 0) {
          if (st.size === lastSize) {
            stableCount += 1;
          } else {
            stableCount = 0;
          }
          lastSize = st.size;

          // Require a couple stable samples to reduce the chance we race an in-progress write.
          if (stableCount >= 2) {
            return candidate;
          }
        }
      } catch {
        // Ignore transient stat failures.
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return candidate;
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
      const wsConnectTimeoutMs = (() => {
        const raw = process.env.PW_VSCODE_TEST_WS_CONNECT_TIMEOUT_MS;
        if (raw === undefined) {
          return 30_000;
        }

        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(
            `PW_VSCODE_TEST_WS_CONNECT_TIMEOUT_MS must be a positive number of milliseconds; got '${raw}'.`
          );
        }

        return n;
      })();

      const transport = (process.env.PW_VSCODE_TEST_TRANSPORT ?? "pipe").trim();
      if (transport !== "ws" && transport !== "pipe") {
        throw new Error(
          `PW_VSCODE_TEST_TRANSPORT must be 'ws' or 'pipe'; got '${transport}'.`
        );
      }

      harnessTrace(
        `RPC server init: transport=${transport}, connectTimeoutMs=${wsConnectTimeoutMs}, platform=${process.platform}, node=${process.version}`
      );

      if (transport === "ws") {
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
        harnessTrace(`RPC server listening (ws): ${url}`);

        const waitForConnection = async (): Promise<RpcTransport> => {
          const existing = pending.shift();
          if (existing) {
            harnessTrace(`RPC waitForConnection satisfied immediately (ws); pending=${pending.length}`);
            return { kind: "ws", socket: existing };
          }

          harnessTrace(
            `RPC waitForConnection waiting (ws); pending=${pending.length}, waiters=${waiters.length}`
          );

          return await new Promise<RpcTransport>((resolve, reject) => {
            let onSocket: ((socket: WebSocket) => void) | undefined;
            const timeout = setTimeout(() => {
              if (onSocket) {
                const idx = waiters.indexOf(onSocket);
                if (idx >= 0) {
                  waiters.splice(idx, 1);
                }
              }

              harnessTrace(
                `RPC waitForConnection timed out (ws) after ${wsConnectTimeoutMs}ms; pending=${pending.length}, waiters=${waiters.length}`
              );
              reject(
                new Error(
                  `Timed out after ${wsConnectTimeoutMs}ms waiting for extension host connection (transport=ws, env=PW_VSCODE_TEST_WS_URL).`
                )
              );
            }, wsConnectTimeoutMs);

            onSocket = (socket: WebSocket) => {
              clearTimeout(timeout);
              harnessTrace(`RPC connection accepted (ws)`);
              resolve({ kind: "ws", socket });

              const idx = pending.indexOf(socket);
              if (idx >= 0) {
                pending.splice(idx, 1);
              }
            };

            waiters.push(onSocket);
            timeout.unref?.();
          });
        };

        try {
          await use({ transport: "ws", url, waitForConnection });
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

        return;
      }

      // transport === 'pipe'
      const sockets = new Set<net.Socket>();
      const pending: net.Socket[] = [];
      const waiters: Array<(socket: net.Socket) => void> = [];
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));

        harnessTrace(
          `RPC connection accepted (pipe); local=${String(
            socket.localAddress
          )}:${String(socket.localPort)} remote=${String(
            socket.remoteAddress
          )}:${String(socket.remotePort)}`
        );

        const waiter = waiters.shift();
        if (waiter) {
          waiter(socket);
        } else {
          pending.push(socket);
        }
      });

      const pipePath = (() => {
        if (process.platform === "win32") {
          return `\\\\.\\pipe\\pw-vscode-test-${crypto.randomUUID()}`;
        }
        // Keep the filename short to avoid Unix domain socket path length limits.
        const name = `pw-vscode-${crypto.randomBytes(6).toString("hex")}.sock`;
        return path.join(os.tmpdir(), name);
      })();

      harnessTrace(`RPC server pipePath: ${pipePath}`);

      if (process.platform !== "win32") {
        // Best-effort cleanup if a previous run left the socket file behind.
        try {
          fs.rmSync(pipePath, { force: true });
        } catch {
          // ignore
        }
      }

      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", (err) => reject(err));
        server.listen(pipePath);
      });

      harnessTrace(`RPC server listening (pipe): ${pipePath}`);

      const waitForConnection = async (): Promise<RpcTransport> => {
        const existing = pending.shift();
        if (existing) {
          harnessTrace(
            `RPC waitForConnection satisfied immediately (pipe); pending=${pending.length}`
          );
          return { kind: "pipe", socket: existing };
        }

        harnessTrace(
          `RPC waitForConnection waiting (pipe); pending=${pending.length}, waiters=${waiters.length}, pipePath=${pipePath}`
        );

        return await new Promise<RpcTransport>((resolve, reject) => {
          let onSocket: ((socket: net.Socket) => void) | undefined;
          const timeout = setTimeout(() => {
            if (onSocket) {
              const idx = waiters.indexOf(onSocket);
              if (idx >= 0) {
                waiters.splice(idx, 1);
              }
            }

            harnessTrace(
              `RPC waitForConnection timed out (pipe) after ${wsConnectTimeoutMs}ms; pending=${pending.length}, waiters=${waiters.length}, pipePath=${pipePath}`
            );
            reject(
              new Error(
                `Timed out after ${wsConnectTimeoutMs}ms waiting for extension host connection (transport=pipe, env=PW_VSCODE_TEST_PIPE_PATH).`
              )
            );
          }, wsConnectTimeoutMs);

          onSocket = (socket: net.Socket) => {
            clearTimeout(timeout);
            harnessTrace(`RPC waitForConnection got socket (pipe)`);
            resolve({ kind: "pipe", socket });

            const idx = pending.indexOf(socket);
            if (idx >= 0) {
              pending.splice(idx, 1);
            }
          };

          waiters.push(onSocket);
          timeout.unref?.();
        });
      };

      try {
        await use({ transport: "pipe", pipePath, waitForConnection });
      } finally {
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }

        await new Promise<void>((resolve) => server.close(() => resolve()));

        if (process.platform !== "win32") {
          try {
            fs.rmSync(pipePath, { force: true });
          } catch {
            // ignore
          }
        }
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

      if (isHarnessTraceEnabled()) {
        const harnessTracePath = testInfo.outputPath(
          "pw-vscode-test-harness-trace.log"
        );
        setHarnessTraceFile(harnessTracePath);
        harnessTrace(`Trace enabled; harness log: ${harnessTracePath}`);
      }

      // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
      // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
      const env = { ...process.env } as Record<string, string>;
      for (const prop in env) {
        if (/^VSCODE_/i.test(prop)) {
          delete env[prop];
        }
      }

      // The extension host VSCodeTestServer connects back to us using the selected transport.
      env.PW_VSCODE_TEST_TRANSPORT = _rpcServer.transport;
      if (_rpcServer.transport === "ws") {
        env.PW_VSCODE_TEST_WS_URL = _rpcServer.url;
      } else {
        env.PW_VSCODE_TEST_PIPE_PATH = _rpcServer.pipePath;
      }

      if (isHarnessTraceEnabled()) {
        env.PW_VSCODE_TEST_TRACE = "1";
        env.PW_VSCODE_TEST_TRACE_FILE = testInfo.outputPath(
          "pw-vscode-test-extension-host-trace.log"
        );
        harnessTrace(
          `Plumbed extension host trace file: ${env.PW_VSCODE_TEST_TRACE_FILE}`
        );
        harnessTrace(
          `Launch env: transport=${env.PW_VSCODE_TEST_TRANSPORT}, wsUrl=${String(
            env.PW_VSCODE_TEST_WS_URL
          )}, pipePath=${String(env.PW_VSCODE_TEST_PIPE_PATH)}`
        );
      }

      // NOTE: VS Code's --extensionTestsPath must point at a JS file. We rely on `npm run compile-tests`
      // to produce `dist/` before running Playwright.
      const testServerEntryPath = path.join(
        __dirname,
        "vscodeTestServer",
        "index.js"
      );

      if (isHarnessTraceEnabled()) {
        harnessTrace(
          `Resolved extensionTestsPath=${testServerEntryPath} exists=${fs.existsSync(
            testServerEntryPath
          )}`
        );
      }

      const videoOptions = normalizeVideoOptions(vscodeVideo);
      const shouldRecordVideo = videoOptions.mode !== "off";
      const videoDir = testInfo.outputPath("videos");
      if (shouldRecordVideo) {
        await fs.promises.mkdir(videoDir, { recursive: true });
      }

      if (process.env.PW_VSCODE_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(
          `PW_VSCODE_DEBUG: vscodeVideo raw=${JSON.stringify(
            vscodeVideo
          )} normalized=${JSON.stringify(videoOptions)} shouldRecordVideo=${shouldRecordVideo} videoDir=${videoDir}`
        );
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

      const electronArgs = [
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
        `--extensionTestsPath=${testServerEntryPath}`,
        ...(extensionDevelopmentPath
          ? [`--extensionDevelopmentPath=${extensionDevelopmentPath}`]
          : []),
        baseDir,
      ];

      if (process.env.PW_VSCODE_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(
          `PW_VSCODE_DEBUG: launching VS Code with argv:\n${electronArgs
            .map((a) => `  ${a}`)
            .join("\n")}`
        );
      }

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
        args: electronArgs,
      });

      if (isHarnessTraceEnabled()) {
        try {
          const proc = electronApp.process();
          if (proc) {
            harnessTrace(`VS Code Electron process started (pid=${proc.pid})`);
            proc.once("exit", (code, signal) => {
              harnessTrace(
                `VS Code Electron process exited (code=${String(
                  code
                )}, signal=${String(signal)})`
              );
            });
            proc.once("error", (err) => {
              harnessTrace(`VS Code Electron process error: ${String(err)}`);
            });
          } else {
            harnessTrace(`VS Code Electron process handle not available`);
          }
        } catch (err) {
          harnessTrace(`Unable to attach to Electron process: ${String(err)}`);
        }
      }

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

      // recordVideo requires the context to close to finalize .webm output.
      // On some hosts (notably containerized runs), the .webm can appear slightly after close.
      if (shouldRecordVideo) {
        const timeoutMsRaw = process.env.PW_VSCODE_VIDEO_FINALIZE_TIMEOUT_MS;
        const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 30_000;
        if (!Number.isNaN(timeoutMs) && timeoutMs > 0) {
          const finalized = await waitForWebmVideoToFinalize({
            videoDir,
            timeoutMs,
          });
          if (process.env.PW_VSCODE_DEBUG) {
            // eslint-disable-next-line no-console
            console.log(
              finalized
                ? `PW_VSCODE_DEBUG: recordVideo finalized: ${finalized}`
                : `PW_VSCODE_DEBUG: recordVideo did not finalize within ${timeoutMs}ms (dir: ${videoDir})`
            );

            try {
              const entries = await fs.promises.readdir(videoDir);
              // eslint-disable-next-line no-console
              console.log(
                `PW_VSCODE_DEBUG: videoDir entries (${videoDir}): ${entries.join(
                  ", "
                )}`
              );
            } catch (err) {
              // eslint-disable-next-line no-console
              console.log(
                `PW_VSCODE_DEBUG: unable to read videoDir (${videoDir}): ${String(
                  err
                )}`
              );
            }
          }
        }
      }

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

    // The extension host entrypoint connects back to our worker-scoped RPC server.
    // Multiple connections are fine; for each test we use the next connection.
    void electronApp;
    harnessTrace(`_evaluator waiting for extension host connection...`);
    const transport = await _rpcServer.waitForConnection();
    harnessTrace(`_evaluator got extension host connection (kind=${transport.kind})`);
    // Our current Playwright build no longer exposes the private tracing hooks
    // expected by the vendored evaluator (Tracing.onBeforeCall/onAfterCall).
    // Disable this integration; VS Code traces are still collected separately.
    const pageImpl = undefined;
    const evaluator = new VSCodeEvaluatorImpl(transport, pageImpl);
    await use(evaluator);

    closeRpcTransport(transport);
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
