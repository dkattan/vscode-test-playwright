import {
  _electron,
  test as base,
  TestInfo,
  TraceMode,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  downloadAndUnzipVSCode,
  makeConsoleReporter,
  ProgressReportStage,
  type ProgressReporter,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import * as cp from "child_process";
import type { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { WebSocket } from "ws";
import {
  ObjectHandle,
  VSCode,
  VSCodeEvaluator,
  VSCodeFunctionOn,
  VSCodeHandle,
} from "./vscodeHandle";
export { expect } from "@playwright/test";

function debugEnabled(): boolean {
  return process.env.PW_VSCODE_DEBUG === "1";
}

function debugLog(message: string) {
  if (!debugEnabled()) return;
  // Keep it grep-friendly in CI logs.
  console.log(`[vscode-test-playwright][debug] ${message}`);
}

export type VSCodeWorkerOptions = {
  vscodeVersion: string;
  /**
   *
   * This is primarily useful for Playwright demo/recording runs that need the
   * machine's existing signed-in state (GitHub/Copilot), which typically lives
   * in the user's normal VS Code profile.
   *
   * Examples (macOS):
   * - /Applications/Visual Studio Code.app
   * - /Applications/Visual Studio Code.app/Contents/MacOS/Electron
   * - /Applications/Visual Studio Code Insiders.app
   */
  vscodeExecutablePath?: string;
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
};

export type VSCodeTestOptions = {
  extensionDevelopmentPath?: string;
  baseDir: string;
};

type VSCodeCommandsLike = {
  executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
};

type VSCodeTestFixtures = {
  electronApp: ElectronApplication;
  workbox: Page;
  /** Convenience wrapper for calling VS Code commands (executeCommand) from Node. */
  vscode: { commands: VSCodeCommandsLike };
  evaluateInVSCode<R>(
    vscodeFunction: VSCodeFunctionOn<VSCode, void, R>
  ): Promise<R>;
  evaluateInVSCode<R, Arg>(
    vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>,
    arg: Arg
  ): Promise<R>;
  evaluateHandleInVSCode<R>(
    vscodeFunction: VSCodeFunctionOn<VSCode, void, R>
  ): Promise<VSCodeHandle<R>>;
  evaluateHandleInVSCode<R, Arg>(
    vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>,
    arg: Arg
  ): Promise<VSCodeHandle<R>>;
};

type ExperimentalVSCodeTestFixtures = {
  _enableRecorder: void;
};

type InternalWorkerFixtures = {
  _createTempDir: () => Promise<string>;
  _vscodeInstall: { installPath: string; cachePath: string; downloadedPath?: string };
};

type InternalTestFixtures = {
  _evaluator: VSCodeEvaluator;
  _vscodeHandle: ObjectHandle<VSCode>;
};

function shouldCaptureTrace(traceMode: TraceMode, testInfo: TestInfo) {
  if (process.env.PW_TEST_DISABLE_TRACING) return false;

  if (traceMode === "on") return true;

  if (traceMode === "retain-on-failure") return true;

  if (traceMode === "on-first-retry" && testInfo.retry === 1) return true;

  if (traceMode === "on-all-retries" && testInfo.retry > 0) return true;

  if (traceMode === "retain-on-first-failure" && testInfo.retry === 0)
    return true;

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
  if (traceMode === "retry-with-trace") return "on-first-retry";
  return traceMode;
}

type VideoMode =
  | "off"
  | "on"
  | "retain-on-failure"
  | "on-first-retry"
  | "on-all-retries";

function getVideoMode(video: unknown): VideoMode {
  const mode = typeof video === "string" ? video : (video as any)?.mode;
  if (mode === "retry-with-video") return "on-first-retry";
  // Default to off when unspecified/malformed.
  return (mode ?? "off") as VideoMode;
}

function shouldCaptureVideo(videoMode: VideoMode, testInfo: TestInfo) {
  if (videoMode === "off") return false;

  if (videoMode === "on") return true;

  // We still need to record to be able to retain on failure.
  if (videoMode === "retain-on-failure") return true;

  if (videoMode === "on-first-retry" && testInfo.retry === 1) return true;

  if (videoMode === "on-all-retries" && testInfo.retry > 0) return true;

  return false;
}

function discoverVSCodeExecutablePath(): string | undefined {
  // Opt-in only: auto-discovery is inherently heuristic and should not silently
  // change CI behavior.
  const enabled = process.env.PW_VSCODE_AUTO_DISCOVER === "1";
  if (!enabled) return undefined;

  if (os.platform() === "darwin") {
    const candidates = [
      "/Applications/Visual Studio Code.app",
      "/Applications/Visual Studio Code Insiders.app",
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }

  // Try PATH lookups (best effort). On macOS this typically returns a shim
  // script, so we still prefer the .app path above.
  const commands =
    os.platform() === "win32"
      ? ["code.cmd", "code"]
      : ["code", "code-insiders"];
  for (const cmd of commands) {
    const res = cp.spawnSync(
      os.platform() === "win32" ? "where" : "which",
      [cmd],
      {
        encoding: "utf8",
      }
    );
    if (res.status === 0 && typeof res.stdout === "string") {
      const firstLine = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (firstLine) return firstLine;
    }
  }

  return undefined;
}

// adapted from https://github.com/microsoft/playwright/blob/a6b320e36224f70ad04fd520503c230d5956ba66/packages/playwright-core/src/server/electron/electron.ts#L294-L320
function waitForLine(
  childProcess: cp.ChildProcess,
  regex: RegExp
): Promise<RegExpMatchArray> {
  function addEventListener(
    emitter: EventEmitter,
    eventName: string | symbol,
    handler: (...args: any[]) => void
  ) {
    emitter.on(eventName, handler);
    return { emitter, eventName, handler };
  }

  function removeEventListeners(
    listeners: Array<{
      emitter: EventEmitter;
      eventName: string | symbol;
      handler: (...args: any[]) => void;
    }>
  ) {
    for (const listener of listeners)
      listener.emitter.removeListener(listener.eventName, listener.handler);
    listeners.splice(0, listeners.length);
  }

  return new Promise((resolve, reject) => {
    const maxRecentLines = 200;
    const recentLines: string[] = [];

    const pushRecent = (source: string, line: string) => {
      const prefixed = `[${source}] ${line}`;
      recentLines.push(prefixed);
      if (recentLines.length > maxRecentLines) {
        recentLines.splice(0, recentLines.length - maxRecentLines);
      }
    };

    const formatRecent = () => {
      if (!recentLines.length) return "<no process output captured>";
      return recentLines.join("\n");
    };

    const failError = new Error(
      `Process failed to launch while waiting for output matching ${regex}.\n` +
        `Recent output (last ${maxRecentLines} lines max):\n${formatRecent()}`
    );

    let finished = false;

    const timeoutMs = (() => {
      const raw = process.env.PW_VSCODE_WAIT_FOR_LINE_TIMEOUT_MS;
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })();

    const timer = timeoutMs
      ? setTimeout(() => {
          finishReject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for process output matching ${regex}.\n` +
                `Recent output (last ${maxRecentLines} lines max):\n${formatRecent()}`
            )
          );
        }, timeoutMs)
      : undefined;

    const rls = [
      childProcess.stdout
        ? {
            source: "stdout",
            rl: readline.createInterface({ input: childProcess.stdout }),
          }
        : undefined,
      childProcess.stderr
        ? {
            source: "stderr",
            rl: readline.createInterface({ input: childProcess.stderr }),
          }
        : undefined,
    ].filter(Boolean) as Array<{ source: string; rl: readline.Interface }>;

    if (!rls.length) {
      finishReject(
        new Error(
          `Process has no stdout/stderr streams; cannot wait for output matching ${regex}.`
        )
      );
      return;
    }

    const listeners = [
      ...rls.map(({ rl, source }) =>
        addEventListener(rl, "line", (line: string) => onLine(source, line))
      ),
      addEventListener(childProcess, "exit", (code: number | null, signal) => {
        finishReject(
          new Error(
            `Process exited before emitting output matching ${regex} (code=${code}, signal=${signal}).\n` +
              `Recent output (last ${maxRecentLines} lines max):\n${formatRecent()}`
          )
        );
      }),
      // It is Ok to remove error handler because we did not create process and there is another listener.
      addEventListener(childProcess, "error", (err: unknown) => {
        finishReject(
          new Error(
            `Process emitted error before emitting output matching ${regex}: ${String(err)}\n` +
              `Recent output (last ${maxRecentLines} lines max):\n${formatRecent()}`
          )
        );
      }),
    ];

    function onLine(source: string, line: string) {
      debugLog(`process output: ${line}`);
      pushRecent(source, line);
      const match = line.match(regex);
      if (!match) return;
      finishResolve(match);
    }

    function finishResolve(match: RegExpMatchArray) {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(match);
    }

    function finishReject(err: Error) {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    }

    function cleanup() {
      if (timer) clearTimeout(timer);
      removeEventListeners(listeners);
      for (const { rl } of rls) {
        try {
          rl.close();
        } catch {
          // ignore
        }
      }
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
  vscodeExecutablePath: [undefined, { option: true, scope: "worker" }],
  extensions: [undefined, { option: true, scope: "worker" }],
  vscodeTrace: ["off", { option: true, scope: "worker" }],
  extensionDevelopmentPath: [undefined, { option: true }],
  baseDir: [
    async ({ _createTempDir }, use) => await use(await _createTempDir()),
    { option: true },
  ],
  extensionsDir: [undefined, { option: true, scope: "worker" }],
  userDataDir: [undefined, { option: true, scope: "worker" }],

  _vscodeInstall: [
    async (
      {
        _createTempDir,
        vscodeVersion,
        vscodeExecutablePath,
        extensions,
        extensionsDir,
        userDataDir,
      },
      use,
      workerInfo
    ) => {
      const cachePath = await _createTempDir();

      const explicitExecutablePath =
        vscodeExecutablePath ??
        process.env.PW_VSCODE_EXECUTABLE_PATH ??
        discoverVSCodeExecutablePath();

      // If the caller provided an explicit VS Code install/executable path,
      // we use it directly (do not download a fresh build).
      //
      // IMPORTANT: We still create a worker-specific cachePath so that any
      // harness artifacts (logs/attachments) have a stable place.
      if (explicitExecutablePath) {
        // Only attempt to install extensions when explicitly requested.
        if (extensions) {
          // @vscode/test-electron expects the *Electron binary* path on macOS
          // (e.g. .../Visual Studio Code.app/Contents/MacOS/Electron). For
          // convenience, we also accept the .app bundle path and normalize it.
          const executablePathForCli = (() => {
            if (os.platform() !== "darwin") {
              return explicitExecutablePath;
            }

            if (explicitExecutablePath.endsWith(".app")) {
              return path.join(
                explicitExecutablePath,
                "Contents",
                "MacOS",
                "Electron"
              );
            }

            return explicitExecutablePath;
          })();

          const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(
            executablePathForCli
          );

          if (!fs.existsSync(cliPath)) {
            throw new Error(
              `VS Code CLI not found at resolved path: ${cliPath}. ` +
                `PW_VSCODE_EXECUTABLE_PATH/vscodeExecutablePath resolved to: ${explicitExecutablePath}. ` +
                `This path is required to install extensions (e.g. github.copilot-chat).`
            );
          }

          await new Promise<void>((resolve, reject) => {
            extensions =
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
                ...extensions.flatMap((extension) => [
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
              if (!code) resolve();
              else
                reject(
                  new Error(
                    `Failed to install extensions: code = ${code}, signal = ${signal}`
                  )
                );
            });
          });
        }

        await use({ installPath: explicitExecutablePath, cachePath });
        return;
      }

      const installBasePath = path.join(
        process.cwd(),
        ".vscode-test",
        `worker-${workerInfo.parallelIndex}`
      );
      await fs.promises.mkdir(installBasePath, { recursive: true });
      let downloadedPath: string | undefined;
      const consoleReporter = await makeConsoleReporter();
      const reporter: ProgressReporter = {
        report: (report) => {
          if (
            report.stage === ProgressReportStage.FoundMatchingInstall ||
            report.stage === ProgressReportStage.NewInstallComplete ||
            report.stage === ProgressReportStage.ReplacingOldInsiders
          ) {
            downloadedPath = report.downloadedPath;
          }
          consoleReporter.report(report);
        },
        error: (err) => consoleReporter.error(err),
      };

      const installPath = await downloadAndUnzipVSCode({
        cachePath: installBasePath,
        version: vscodeVersion,
        reporter,
      });

      // Helpful for CI diagnostics: this prints once per worker.
      console.log(
        `[vscode-test-playwright] downloadAndUnzipVSCode returned: ${installPath}` +
          (downloadedPath
            ? ` (downloadedPath: ${downloadedPath})`
            : " (downloadedPath unavailable)")
      );
      const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(installPath);

      if (!fs.existsSync(cliPath)) {
        throw new Error(
          `VS Code CLI not found at resolved path: ${cliPath}. ` +
            `downloadAndUnzipVSCode returned: ${installPath}. ` +
            `This path is required to install extensions (e.g. github.copilot-chat).`
        );
      }

      if (extensions) {
        await new Promise<void>((resolve, reject) => {
          extensions =
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
              ...extensions.flatMap((extension) => [
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
            if (!code) resolve();
            else
              reject(
                new Error(
                  `Failed to install extensions: code = ${code}, signal = ${signal}`
                )
              );
          });
        });
      }

      await use({ installPath, cachePath, downloadedPath });
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
        extensions,
        extensionsDir,
        userDataDir,
      },
      use,
      testInfo
    ) => {
      const { installPath, cachePath, downloadedPath } = _vscodeInstall;

      const videoOption = (testInfo.project.use as any)?.video;
      const videoMode = getVideoMode(videoOption);
      const captureVideo = shouldCaptureVideo(videoMode, testInfo);
      const videoSize =
        typeof videoOption === "object" && videoOption
          ? (videoOption as any).size
          : undefined;
      const videoDir = captureVideo ? testInfo.outputPath("video") : undefined;
      if (videoDir) {
        await fs.promises.mkdir(videoDir, { recursive: true });
      }


      // Default to isolation for deterministic runs (opt out with =0).
      const isolateExtensionsDir =
        process.env.PW_VSCODE_ISOLATE_EXTENSIONS_DIR !== "0";

      // Always launch with an explicit user-data-dir to avoid macOS single-instance
      // handoff behavior (which can cause the Electron app to exit immediately and
      // tests to fail at firstWindow()).
      //
      // Precedence:
      // - userDataDir option (caller-controlled)
      // - default temp user data dir (fresh, isolated)
      const effectiveUserDataDir =
        userDataDir ?? path.join(cachePath, "user-data");

      // Ensure the directory exists so VS Code doesn't attempt to reuse a shared
      // default user profile.
      await fs.promises.mkdir(effectiveUserDataDir, { recursive: true });

      // Optionally force a temp extensions directory to avoid picking up arbitrary
      // user-installed extensions (e.g. ~/.vscode/extensions) which can destabilize
      // CI/recording runs.
      const effectiveExtensionsDir =
        extensionsDir ?? (isolateExtensionsDir ? path.join(cachePath, "extensions") : undefined);

      if (effectiveExtensionsDir) {
        await fs.promises.mkdir(effectiveExtensionsDir, { recursive: true });
      }

      // Playwright's Electron launcher needs the actual executable.
      // On macOS, @vscode/test-electron provides an install directory containing
      // `Visual Studio Code.app`, so we must point at `.../Contents/MacOS/Electron`.
      const electronExecutablePath = (() => {
        const platform = os.platform();

        // Prefer the install directory (downloadedPath) when available, because
        // @vscode/test-electron may return a platform-specific launcher path.
        // However, when @vscode/test-electron returns a direct Electron binary
        // path (common on macOS), we must not discard it.
        if (downloadedPath && fs.existsSync(installPath)) {
          try {
            const installStat = fs.statSync(installPath);
            if (installStat.isFile()) {
              return installPath;
            }
          } catch {
            // Ignore and fall back to directory resolution below.
          }
        }

        const pathForResolution = downloadedPath ?? installPath;

        if (!fs.existsSync(pathForResolution)) {
          throw new Error(
            `VS Code installPath does not exist: ${pathForResolution}. ` +
              `downloadAndUnzipVSCode returned: ${installPath}. ` +
              (downloadedPath
                ? `Progress reporter downloadedPath: ${downloadedPath}. `
                : "Progress reporter downloadedPath not available. ")
          );
        }

        const stat = fs.statSync(pathForResolution);

        // If the path is already a file (executable), use it directly.
        if (stat.isFile()) {
          return pathForResolution;
        }

        // macOS: @vscode/test-electron often returns an install directory
        // containing the .app bundle; Playwright needs the Electron binary.
        if (platform === "darwin") {
          const appBundlePath = pathForResolution.endsWith(".app")
            ? pathForResolution
            : path.join(pathForResolution, "Visual Studio Code.app");
          const candidate = path.join(
            appBundlePath,
            "Contents",
            "MacOS",
            "Electron"
          );
          if (!fs.existsSync(candidate)) {
            throw new Error(
              `VS Code Electron executable not found at expected path: ${candidate}. ` +
                `Resolved installPath: ${pathForResolution}`
            );
          }
          return candidate;
        }

        // Windows/Linux: downloadAndUnzipVSCode typically returns an install directory.
        // Playwright's Electron launcher requires the actual executable.
        if (stat.isDirectory()) {
          const candidates =
            platform === "win32"
              ? [
                  "Code.exe",
                  "Code - Insiders.exe",
                  "code.exe",
                  path.join("bin", "code.cmd"),
                ]
              : ["code", "code-insiders"];

          for (const rel of candidates) {
            const abs = path.join(pathForResolution, rel);
            if (fs.existsSync(abs)) {
              return abs;
            }
          }

          throw new Error(
            `VS Code executable not found under installPath directory: ${pathForResolution}. ` +
              `Tried: ${candidates.join(", ")}`
          );
        }

        throw new Error(
          `Unsupported VS Code installPath type for: ${pathForResolution}. ` +
            `Expected a file or directory.`
        );
      })();

      debugLog(`installPath=${installPath}`);
      if (downloadedPath) debugLog(`downloadedPath=${downloadedPath}`);
      debugLog(`electronExecutablePath=${electronExecutablePath}`);
      debugLog(`effectiveUserDataDir=${effectiveUserDataDir}`);
      debugLog(
        `effectiveExtensionsDir=${effectiveExtensionsDir ?? "<default>"} (isolate=${isolateExtensionsDir})`
      );

      // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
      // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
      const env = { ...process.env } as Record<string, string>;
      let removedEnvCount = 0;
      for (const prop in env) {
        if (/^VSCODE_/i.test(prop)) {
          delete env[prop];
          removedEnvCount++;
        }
      }
      debugLog(`removed ${removedEnvCount} VSCODE_* env vars`);

      const electronApp = await _electron.launch({
        executablePath: electronExecutablePath,
        env,
        ...(captureVideo
          ? {
              recordVideo: {
                dir: videoDir!,
                ...(videoSize ? { size: videoSize } : {}),
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
          // Only pin dirs when the caller explicitly asked for them OR when we
          // installed extensions into a temp dir for this run.
          ...(extensions || effectiveExtensionsDir
            ? [`--extensions-dir=${effectiveExtensionsDir ?? path.join(cachePath, "extensions")}`]
            : []),
          ...(effectiveUserDataDir
            ? [`--user-data-dir=${effectiveUserDataDir}`]
            : []),
          `--extensionTestsPath=${path.join(__dirname, "injected", "index")}`,
          ...(extensionDevelopmentPath
            ? [`--extensionDevelopmentPath=${extensionDevelopmentPath}`]
            : []),
          baseDir,
        ],
      });

      debugLog(`_electron.launch() returned; waiting for firstWindow()`);

      // Capture early process output to aid debugging when VS Code exits before firstWindow() is ready.
      const outputLineLimit = 2000;
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const pushLines = (target: string[], chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          target.push(line);
          if (target.length > outputLineLimit)
            target.splice(0, target.length - outputLineLimit);
        }
      };

      const childProcess = electronApp.process();
      const onStdout = (b: Buffer) => pushLines(stdoutLines, b);
      const onStderr = (b: Buffer) => pushLines(stderrLines, b);
      childProcess?.stdout?.on("data", onStdout);
      childProcess?.stderr?.on("data", onStderr);

      // Sanity-check logging: if PW_VSCODE_DEBUG=1, mirror output live to the
      // test runner console so it's visible without opening attachments.
      if (debugEnabled()) {
        childProcess?.stdout?.on("data", (b) => {
          for (const l of b.toString("utf8").split(/\r?\n/)) {
            if (l) console.log(`[vscode-test-playwright][vscode stdout] ${l}`);
          }
        });
        childProcess?.stderr?.on("data", (b) => {
          for (const l of b.toString("utf8").split(/\r?\n/)) {
            if (l) console.log(`[vscode-test-playwright][vscode stderr] ${l}`);
          }
        });
        childProcess?.on("exit", (code, signal) => {
          console.log(
            `[vscode-test-playwright][debug] VS Code process exited: code=${code}, signal=${signal}`
          );
        });
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

      const pagesForVideo = captureVideo ? electronApp.windows().slice() : [];

      // If VS Code crashes/exits early, closing the Electron application can throw.
      // We still want to copy whatever logs exist to the test output for diagnosis.
      let closeError: unknown;
      try {
        // recordVideo requires the context to close to finalize .webm output.
        // Closing the Electron app should close the underlying context, but we
        // explicitly close the context first to ensure videos are flushed.
        if (captureVideo) {
          await electronApp.context().close();
        }
        await electronApp.close();
      } catch (e) {
        closeError = e;
      }

      if (captureVideo && videoDir) {
        const testFailed = testInfo.status !== testInfo.expectedStatus;
        const shouldKeep = !(videoMode === "retain-on-failure" && !testFailed);

        if (shouldKeep) {
          const seenPaths = new Set<string>();
          for (let i = 0; i < pagesForVideo.length; i++) {
            const page = pagesForVideo[i];
            try {
              const video = page.video();
              if (!video) continue;
              const p = await video.path();
              if (!p || seenPaths.has(p)) continue;
              seenPaths.add(p);
              testInfo.attachments.push({
                name: `video-${i + 1}`,
                path: p,
                contentType: "video/webm",
              });
            } catch (e) {
              testInfo.attachments.push({
                name: `video-path-error-${i + 1}`,
                body: Buffer.from(String(e)),
                contentType: "text/plain",
              });
            }
          }
        } else {
          // Match Playwright's retain-on-failure behavior by deleting artifacts
          // when the test passed.
          try {
            await fs.promises.rm(videoDir, { recursive: true, force: true });
          } catch (e) {
            testInfo.attachments.push({
              name: "video-delete-error",
              body: Buffer.from(String(e)),
              contentType: "text/plain",
            });
          }
        }
      }

      // Detach listeners and attach captured output for diagnostics.
      try {
        childProcess?.stdout?.off("data", onStdout);
        childProcess?.stderr?.off("data", onStderr);
      } catch {
        // Ignore listener cleanup errors.
      }

      if (stdoutLines.length) {
        try {
          const outPath = testInfo.outputPath("vscode-stdout.txt");
          await fs.promises.writeFile(outPath, stdoutLines.join("\n"), "utf8");
          testInfo.attachments.push({
            name: "vscode-stdout",
            path: outPath,
            contentType: "text/plain",
          });
        } catch (e) {
          testInfo.attachments.push({
            name: "vscode-stdout-write-error",
            body: Buffer.from(String(e)),
            contentType: "text/plain",
          });
        }
      }
      if (stderrLines.length) {
        try {
          const errPath = testInfo.outputPath("vscode-stderr.txt");
          await fs.promises.writeFile(errPath, stderrLines.join("\n"), "utf8");
          testInfo.attachments.push({
            name: "vscode-stderr",
            path: errPath,
            contentType: "text/plain",
          });
        } catch (e) {
          testInfo.attachments.push({
            name: "vscode-stderr-write-error",
            body: Buffer.from(String(e)),
            contentType: "text/plain",
          });
        }
      }

      const logPath = path.join(effectiveUserDataDir, "logs");
      try {
        if (fs.existsSync(logPath)) {
          const logOutputPath = test.info().outputPath("vscode-logs");
          await fs.promises.cp(logPath, logOutputPath, { recursive: true });
        }
      } catch (e) {
        // Surface log copy failures without hiding the original test failure.
        testInfo.attachments.push({
          name: "vscode-logs-copy-error",
          body: Buffer.from(String(e)),
          contentType: "text/plain",
        });
      }

      if (closeError) {
        testInfo.attachments.push({
          name: "electron-app-close-error",
          body: Buffer.from(String(closeError)),
          contentType: "text/plain",
        });
      }
    },
    { timeout: 0 },
  ],

  workbox: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow());
  },

  page: ({ workbox }, use) => use(workbox),

  context: ({ electronApp }, use) => use(electronApp.context()),

  _evaluator: async ({ electronApp }, use) => {
    // NOTE: Avoid relying on Playwright internal APIs like `playwright._toImpl`,
    // which are not stable across Playwright releases.

    const process = electronApp.process();
    if (!process) {
      throw new Error("Could not access Electron child process for VS Code");
    }

    // Wait for URL to access VSCode test server.
    const vscodeTestServerRegExp =
      /^VSCodeTestServer listening on (http:\/\/.*)$/;
    debugLog(`waiting for test server line: ${vscodeTestServerRegExp}`);
    const match = await waitForLine(process, vscodeTestServerRegExp);
    debugLog(`matched test server line; url=${match[1]}`);
    const ws = new WebSocket(match[1]);
    ws.on("error", (e) => debugLog(`test server websocket error: ${String(e)}`));
    ws.on("close", (code, reason) =>
      debugLog(
        `test server websocket closed: code=${code}, reason=${reason.toString()}`
      )
    );
    await new Promise((r) => ws.once("open", r));
    debugLog(`test server websocket open`);
    // Without access to Playwright internal Page implementation, tracing
    // integration is disabled. Calls still work; they just won't be added to
    // the trace timeline.
    const evaluator = new VSCodeEvaluator(ws, undefined);
    await use(evaluator);
    ws.close();
  },

  _vscodeHandle: async ({ _evaluator }, use) => {
    await use(_evaluator.rootHandle());
  },

  vscode: async ({ _vscodeHandle }, use) => {
    const vscode: { commands: VSCodeCommandsLike } = {
      commands: {
        executeCommand: async (command: string, ...args: unknown[]) => {
          return await _vscodeHandle.evaluate(
            (vscode, payload) =>
              vscode.commands.executeCommand(payload.command, ...payload.args),
            { command, args },
          );
        },
      },
    };

    await use(vscode);
  },

  evaluateInVSCode: async ({ _vscodeHandle }, use) => {
    // @ts-ignore
    await use((fn, arg) => _vscodeHandle.evaluate(fn, arg));
  },

  evaluateHandleInVSCode: async ({ _vscodeHandle }, use) => {
    const handles: ObjectHandle<unknown>[] = [];
    // @ts-ignore
    await use(async (fn, arg) => {
      const handle = await _vscodeHandle.evaluateHandle(fn, arg);
      handles.push(handle);
      return handle;
    });
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
      for (const tempDir of tempDirs)
        await fs.promises.rm(tempDir, { recursive: true });
    },
    { scope: "worker" },
  ],

  _enableRecorder: [
    async ({ context }, use) => {
      const skip = !!process.env.CI;
      let closePromise: Promise<void> | undefined;
      if (!skip) {
        await (context as any)._enableRecorder({
          language: "playwright-test",
          mode: "recording",
        });
        // Playwright's recorder wiring is internal and varies across versions.
        // Best-effort: if we can observe recorder close, wait for it; otherwise
        // continue without blocking.
        const recorderAppForTest = (context as any)?.recorderAppForTest;
        if (recorderAppForTest?.once) {
          closePromise = new Promise((resolve) =>
            recorderAppForTest.once("close", resolve)
          );
        }
      }
      await use();
      if (closePromise) await closePromise;
    },
    { timeout: 0 },
  ],
});
