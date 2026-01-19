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

function resolveDefaultVSCodeUserDataDir(): string {
  // VS Code default user data locations.
  // We only implement the stable channel paths here. If you use Insiders or a
  // non-default profile, override via PW_VSCODE_CLONE_USER_DATA_FROM and/or
  // PW_VSCODE_PROFILE.
  const home = os.homedir();
  switch (os.platform()) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Code");
    case "win32": {
      const appData = process.env.APPDATA;
      if (!appData) {
        throw new Error(
          "APPDATA is not set; cannot resolve default VS Code user data dir on Windows. "
          + "Set PW_VSCODE_CLONE_USER_DATA_FROM to an explicit path.",
        );
      }
      return path.join(appData, "Code");
    }
    case "linux":
      return path.join(home, ".config", "Code");
    default:
      throw new Error(
        `Unsupported platform '${os.platform()}' for default user data dir resolution. `
        + "Set PW_VSCODE_CLONE_USER_DATA_FROM to an explicit path.",
      );
  }
}

function resolveDefaultVSCodeExtensionsDir(): string {
  // Default VS Code extension install locations.
  const home = os.homedir();
  switch (os.platform()) {
    case "darwin":
    case "linux":
      return path.join(home, ".vscode", "extensions");
    case "win32":
      return path.join(home, ".vscode", "extensions");
    default:
      throw new Error(
        `Unsupported platform '${os.platform()}' for default extensions dir resolution. `
        + "Set PW_VSCODE_EXTENSIONS_DIR to an explicit path.",
      );
  }
}

function resolveExtensionsDirOverride(cachePath: string): string {
  const explicit = (process.env.PW_VSCODE_EXTENSIONS_DIR ?? "").trim();
  if (explicit) {
    return explicit;
  }

  const useDefault = (process.env.PW_VSCODE_USE_DEFAULT_EXTENSIONS_DIR ?? "").trim();
  if (useDefault === "1" || useDefault.toLowerCase() === "true") {
    return resolveDefaultVSCodeExtensionsDir();
  }

  return path.join(cachePath, "extensions");
}

async function cloneUserDataDir(
  sourceUserDataDir: string,
  targetUserDataDir: string,
  cloneMode: string
): Promise<void> {
  // Clone the user's VS Code profile into an isolated directory.
  //
  // Why: When VS Code is already running, reusing the default user-data dir can
  // cause a singleton handoff (the spawned Electron process exits quickly).
  // Cloning preserves auth state (Copilot/GitHub) while ensuring Playwright gets
  // a dedicated --user-data-dir.
  console.log(
    `[vscode-test-playwright] Cloning VS Code user data (mode=${cloneMode}) from '${sourceUserDataDir}' -> '${targetUserDataDir}'`,
  );
  await fs.promises.mkdir(targetUserDataDir, { recursive: true });

  if (cloneMode === "full") {
    // Copy everything.
    await fs.promises.cp(sourceUserDataDir, targetUserDataDir, {
      recursive: true,
      errorOnExist: false,
      force: true,
    });
    return;
  }

  // Minimal clone: copy machine identity plus a narrow allowlist of VS Code state.
  //
  // IMPORTANT: Many users accumulate multi-GB extension caches under User/globalStorage
  // (e.g. other AI extensions). Copying the entire User folder can look like a “hang”.
  // For this repo's demo we only need Copilot/Chat state.
  const rootFilesToCopy = ["machineid", "storage.json"];
  for (const f of rootFilesToCopy) {
    const src = path.join(sourceUserDataDir, f);
    const dst = path.join(targetUserDataDir, f);
    if (fs.existsSync(src)) {
      await fs.promises.cp(src, dst, { force: true });
    }
  }

  const srcUserDir = path.join(sourceUserDataDir, "User");
  if (!fs.existsSync(srcUserDir)) {
    throw new Error(
      `PW_VSCODE_CLONE_USER_DATA_FROM resolved to '${sourceUserDataDir}', but it has no 'User' directory.`,
    );
  }

  const dstUserDir = path.join(targetUserDataDir, "User");
  await fs.promises.mkdir(dstUserDir, { recursive: true });

  // Copy only selected globalStorage entries.
  const srcGlobalStorage = path.join(srcUserDir, "globalStorage");
  const dstGlobalStorage = path.join(dstUserDir, "globalStorage");
  if (fs.existsSync(srcGlobalStorage)) {
    const allowTopLevel = new Set([
      // VS Code global storage db + metadata
      "state.vscdb",
      "state.vscdb.backup",
      "storage.json",
      // Copilot / chat state
      "github.copilot",
      "github.copilot-chat",
      // VS Code chat session persistence (helps avoid first-run prompts)
      "emptyWindowChatSessions",
      // If this repo's Azure Copilot tooling is installed, keep its state too.
      "ms-azuretools.vscode-azure-github-copilot",
    ]);

    await fs.promises.cp(srcGlobalStorage, dstGlobalStorage, {
      recursive: true,
      errorOnExist: false,
      force: true,
      filter: (src: string) => {
        const rel = path.relative(srcGlobalStorage, src);
        if (!rel || rel === ".") {
          return true;
        }
        const first = rel.split(path.sep)[0];
        return allowTopLevel.has(first);
      },
    } as any);
  }

  // Copy a couple of small, frequently-used user settings files (optional).
  const userFilesToCopy = ["settings.json", "keybindings.json", "argv.json"];
  for (const f of userFilesToCopy) {
    const src = path.join(srcUserDir, f);
    const dst = path.join(dstUserDir, f);
    if (fs.existsSync(src)) {
      await fs.promises.cp(src, dst, { force: true });
    }
  }

  console.log("[vscode-test-playwright] Finished cloning VS Code user data.");
}

function resolveVsCodeExecutablePathOverride(): string | undefined {
  const raw = process.env.PW_VSCODE_EXECUTABLE_PATH;
  if (!raw) {
    return undefined;
  }
  const p = raw.trim();
  if (!p) {
    return undefined;
  }

  // On macOS, allow passing either the .app bundle OR the inner binary.
  // Playwright's Electron launcher needs an executable file.
  if (os.platform() === "darwin") {
    const appBundleSuffix = ".app";
    if (p.endsWith(appBundleSuffix) && fs.existsSync(p) && fs.lstatSync(p).isDirectory()) {
      const inner = path.join(p, "Contents", "MacOS", "Electron");
      if (!fs.existsSync(inner)) {
        throw new Error(
          `PW_VSCODE_EXECUTABLE_PATH points at '${p}', but '${inner}' does not exist. `
          + "Set PW_VSCODE_EXECUTABLE_PATH to the inner executable or install VS Code normally.",
        );
      }
      return inner;
    }
  }

  return p;
}

function resolveCloneSourceFromEnv(): string | undefined {
  const raw = process.env.PW_VSCODE_CLONE_USER_DATA_FROM;
  if (!raw) {
    return undefined;
  }
  const v = raw.trim();
  if (!v) {
    return undefined;
  }
  if (v === "default") {
    return resolveDefaultVSCodeUserDataDir();
  }
  return v;
}

function resolveProfileArgFromEnv(): string | undefined {
  const raw = process.env.PW_VSCODE_PROFILE;
  if (!raw) {
    return undefined;
  }
  const v = raw.trim();
  return v ? v : undefined;
}

export type VSCodeWorkerOptions = {
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
};

export type VSCodeTestOptions = {
  extensionDevelopmentPath?: string;
  baseDir: string;
};

type VSCodeTestFixtures = {
  electronApp: ElectronApplication;
  workbox: Page;
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
  _vscodeInstall: { installPath: string; cachePath: string };
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

// adapted from https://github.com/microsoft/playwright/blob/a6b320e36224f70ad04fd520503c230d5956ba66/packages/playwright-core/src/server/electron/electron.ts#L294-L320
function waitForLine(
  process: cp.ChildProcess,
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
    const rl = readline.createInterface({ input: process.stderr! });
    const failError = new Error("Process failed to launch!");
    const listeners = [
      addEventListener(rl, "line", onLine),
      addEventListener(rl, "close", reject.bind(null, failError)),
      addEventListener(process, "exit", reject.bind(null, failError)),
      // It is Ok to remove error handler because we did not create process and there is another listener.
      addEventListener(process, "error", reject.bind(null, failError)),
    ];

    function onLine(line: string) {
      const match = line.match(regex);
      if (!match) return;
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
      const executableOverride = resolveVsCodeExecutablePathOverride();
      const installPath =
        executableOverride ??
        (await downloadAndUnzipVSCode({
          cachePath: installBasePath,
          version: vscodeVersion,
        }));
      const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(installPath);

      if (extensions) {
        await new Promise<void>((resolve, reject) => {
          const extensionsList =
            typeof extensions === "string" ? [extensions] : extensions;

          // Allow env-driven user-data cloning for installs that require auth state.
          // (Primarily used by demo flows; normal tests can omit these env vars.)
          const cloneFrom = resolveCloneSourceFromEnv();
          const cloneMode = (process.env.PW_VSCODE_CLONE_MODE ?? "minimal").trim();
          const resolvedUserDataDir =
            userDataDir ?? (cloneFrom ? path.join(cachePath, "user-data-clone") : undefined);
          const resolvedExtensionsDir =
            extensionsDir ?? resolveExtensionsDirOverride(cachePath);

          const doInstall = async () => {
            try {
              if (cloneFrom && resolvedUserDataDir) {
                await cloneUserDataDir(cloneFrom, resolvedUserDataDir, cloneMode);
              }

              const subProcess = cp.spawn(
                cliPath,
                [
                  `--extensions-dir=${resolvedExtensionsDir}`,
                  `--user-data-dir=${resolvedUserDataDir ?? path.join(cachePath, "user-data")}`,
                  ...(extensionsList ?? []).flatMap((extension: string) => [
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
            }
            catch (e) {
              reject(e);
            }
          };

          void doInstall();
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
      },
      use,
      testInfo
    ) => {
      const { installPath, cachePath } = _vscodeInstall;

      const resolvedExtensionsDir =
        extensionsDir ?? resolveExtensionsDirOverride(cachePath);

      // Env-driven user data cloning. This is used by this repo's demo flow
      // to launch VS Code already authenticated to Copilot/GitHub.
      const cloneFrom = resolveCloneSourceFromEnv();
      const cloneMode = (process.env.PW_VSCODE_CLONE_MODE ?? "minimal").trim();
      const resolvedUserDataDir =
        userDataDir ?? (cloneFrom ? path.join(cachePath, "user-data-clone") : undefined);
      if (cloneFrom && resolvedUserDataDir) {
        await cloneUserDataDir(cloneFrom, resolvedUserDataDir, cloneMode);
      }

      const profileArg = resolveProfileArgFromEnv();

      // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
      // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
      const env = { ...process.env } as Record<string, string>;
      for (const prop in env) {
        if (/^VSCODE_/i.test(prop)) delete env[prop];
      }

      // If the caller explicitly provides an executable path, prefer it.
      // (Used for demo runs where the system-installed VS Code is already signed in.)
      const executableOverride = resolveVsCodeExecutablePathOverride();

      const electronApp = await _electron.launch({
        executablePath: executableOverride ?? installPath,
        env,
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
          `--extensions-dir=${
            resolvedExtensionsDir
          }`,
          `--user-data-dir=${
            resolvedUserDataDir ?? path.join(cachePath, "user-data")
          }`,
          ...(profileArg ? [`--profile=${profileArg}`] : []),
          `--extensionTestsPath=${path.join(__dirname, "injected", "index")}`,
          ...(extensionDevelopmentPath
            ? [`--extensionDevelopmentPath=${extensionDevelopmentPath}`]
            : []),
          baseDir,
        ],
      });

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
    { playwright, electronApp, workbox, vscodeTrace },
    use,
    testInfo
  ) => {
    const electronAppImpl = await (playwright as any)._toImpl(electronApp);
    const pageImpl = await (playwright as any)._toImpl(workbox);
    // check recent logs or wait for URL to access VSCode test server
    const vscodeTestServerRegExp =
      /^VSCodeTestServer listening on (http:\/\/.*)$/;
    const process = electronAppImpl._process as cp.ChildProcess;
    const recentLogs =
      electronAppImpl._nodeConnection._browserLogsCollector.recentLogs() as string[];
    let [match] = recentLogs
      .map((s) => s.match(vscodeTestServerRegExp))
      .filter(Boolean);
    if (!match) {
      match = await waitForLine(process, vscodeTestServerRegExp);
    }
    const ws = new WebSocket(match[1]);
    await new Promise((r) => ws.once("open", r));
    const traceMode = getTraceMode(vscodeTrace);
    const captureTrace = shouldCaptureTrace(traceMode, testInfo);
    const evaluator = new VSCodeEvaluator(
      ws,
      captureTrace ? pageImpl : undefined
    );
    await use(evaluator);
    ws.close();
  },

  _vscodeHandle: async ({ _evaluator }, use) => {
    await use(_evaluator.rootHandle());
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
        try {
          await fs.promises.rm(tempDir, {
            recursive: true,
            force: true,
            // VS Code can keep background file handles briefly after close.
            // Retrying avoids flaky ENOTEMPTY/EBUSY during cleanup.
            maxRetries: 10,
            retryDelay: 100,
          } as any);
        }
        catch (e) {
          // Cleanup failures should not fail the test run.
          // Emit a warning for diagnostics and continue.
          console.warn(`Failed to cleanup temp dir '${tempDir}':`, e);
        }
    },
    { scope: "worker" },
  ],

  _enableRecorder: [
    async ({ playwright, context }, use) => {
      const skip = !!process.env.CI;
      let closePromise: Promise<void> | undefined;
      if (!skip) {
        await (context as any)._enableRecorder({
          language: "playwright-test",
          mode: "recording",
        });
        const contextImpl = await (playwright as any)._toImpl(context);
        closePromise = new Promise((resolve) =>
          contextImpl.recorderAppForTest.once("close", resolve)
        );
      }
      await use();
      if (closePromise) await closePromise;
    },
    { timeout: 0 },
  ],
});
