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

export type VSCodeWorkerOptions = {
  vscodeVersion: string;
  /**
   * Optional explicit VS Code install/executable path to launch instead of downloading
   * via @vscode/test-electron.
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
  /**
   * Optional VS Code profile name to use when launching.
   *
   * This is useful when your GitHub/Copilot auth lives in a non-default VS Code
   * profile (VS Code Profiles feature). In that case, launching without an
   * explicit profile can appear “not signed in” even though your normal VS Code
   * window is.
   *
   * Can also be set via env var: PW_VSCODE_PROFILE
   */
  vscodeProfile?: string;
  /**
   * If set (via fixture option or env), copy an existing VS Code user data dir
   * into a per-run temp directory and launch with --user-data-dir pointing at
   * that clone. This avoids VS Code single-instance handoff (which would make
   * the spawned Electron process exit immediately) while retaining sign-in state.
   */
  cloneUserDataDirFrom?: string;
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

function shouldSkipUserDataEntry(entryName: string) {
  // These directories are large and not required for auth state.
  // Skipping them dramatically speeds up "clone user data" startup.
  // NOTE: We do NOT skip User/, User/globalStorage/, User/workspaceStorage/.
  const skipNames = new Set([
    "Cache",
    "Code Cache",
    "GPUCache",
    "CachedData",
    "logs",
    "Crashpad",
    "CrashpadMetrics-active.pma",
  ]);
  return skipNames.has(entryName);
}

type CloneMode = "full" | "minimal";

function getCloneMode(): CloneMode {
  const mode = (process.env.PW_VSCODE_CLONE_MODE ?? "full").toLowerCase();
  if (mode === "minimal") return "minimal";
  return "full";
}

function getCloneExcludePaths(): string[] {
  // Comma-separated list of user-data relative paths to exclude from cloning.
  // Examples:
  // - User/workspaceStorage
  // - User/globalStorage/github.copilot-chat
  // - User/storage.json
  const raw = process.env.PW_VSCODE_CLONE_EXCLUDE_PATHS;
  if (!raw) return [];

  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\\/g, "/"));

  const normalized: string[] = [];
  for (const p of parsed) {
    if (path.isAbsolute(p)) {
      throw new Error(
        `PW_VSCODE_CLONE_EXCLUDE_PATHS entries must be relative to the VS Code user data dir. Got absolute path: ${p}`
      );
    }
    const n = path.posix.normalize(p);
    if (n === "." || n === "") {
      throw new Error(
        `PW_VSCODE_CLONE_EXCLUDE_PATHS entries must not be empty. Got: ${JSON.stringify(
          p
        )}`
      );
    }
    const parts = n.split("/");
    if (parts.some((seg) => seg === "..")) {
      throw new Error(
        `PW_VSCODE_CLONE_EXCLUDE_PATHS entries must not contain '..'. Got: ${p}`
      );
    }
    normalized.push(n);
  }
  return normalized;
}

function shouldExcludeRelativePath(
  relativePosixPath: string,
  excludePaths: string[]
): boolean {
  if (!excludePaths.length) return false;
  const rel = path.posix.normalize(relativePosixPath.replace(/\\/g, "/"));
  return excludePaths.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

function shouldIncludeGlobalStorageInClone(): boolean {
  // User/globalStorage contains extension global state. This is often where auth/session
  // context is persisted for extensions like Copilot and GitHub Pull Requests.
  //
  // For experimentation, allow opting out.
  // Set PW_VSCODE_CLONE_INCLUDE_GLOBAL_STORAGE=0 to skip copying User/globalStorage.
  const raw = (
    process.env.PW_VSCODE_CLONE_INCLUDE_GLOBAL_STORAGE ?? "1"
  ).trim();
  return raw !== "0";
}

function getGlobalStorageAllowlist(): string[] {
  // Comma-separated extension ids.
  // Example: github.copilot-chat,github.copilot
  const raw = process.env.PW_VSCODE_CLONE_GLOBAL_STORAGE_ALLOWLIST;
  if (!raw) {
    return ["github.copilot", "github.copilot-chat"];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sanitizeClonedUserDataDir(userDataDir: string) {
  // When reusing cached clones, stale socket/lock artifacts can break startup.
  // Example: connect ENOTSOCK <...>/1.10-main.sock
  const rootNamesToRemove = new Set([
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "lockfile",
  ]);

  // Fast-path: VS Code places its IPC artifacts at the root of the user data dir.
  // If these exist but are not sockets (e.g. after a crash/copy), startup can fail
  // with ENOTSOCK before Playwright can attach.
  try {
    const entries = await fs.promises.readdir(userDataDir, {
      withFileTypes: true,
    });
    await Promise.all(
      entries.map(async (e) => {
        const shouldRemove =
          rootNamesToRemove.has(e.name) ||
          e.name.endsWith(".sock") ||
          e.name.endsWith(".sock.lock");
        if (!shouldRemove) return;
        try {
          await fs.promises.rm(path.join(userDataDir, e.name), {
            force: true,
            recursive: e.isDirectory(),
          });
        } catch {
          // Ignore per-entry failures; startup will surface remaining issues.
        }
      })
    );
  } catch {
    // Ignore root sanitize failures; proceed with best-effort.
  }

  // Best-effort deeper cleanup: remove matching files/sockets anywhere under the clone.
  // This is intentionally lenient: permission errors can occur in copied state, but
  // removing what we can is still better than giving up.
  const patterns = ["*.sock", "*.sock.lock", ...Array.from(rootNamesToRemove)];
  for (const p of patterns) {
    try {
      // Use native globbing via find to avoid bringing in extra deps.
      const res = cp.spawnSync(
        "find",
        [
          userDataDir,
          "(",
          "-type",
          "f",
          "-o",
          "-type",
          "s",
          ")",
          "-name",
          p,
          "-print",
        ],
        { encoding: "utf8" }
      );
      if (!res.stdout) continue;
      const files = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const f of files) {
        try {
          await fs.promises.rm(f, { force: true });
        } catch {
          // Ignore per-file failures; startup will surface remaining issues.
        }
      }
    } catch {
      // Ignore sanitize failures; startup will surface remaining issues.
    }
  }
}

async function copyVSCodeUserDataDir(
  srcUserDataDir: string,
  destUserDataDir: string,
  logPrefix?: string
) {
  const mode = getCloneMode();
  const allowlist = new Set(getGlobalStorageAllowlist());
  const includeGlobalStorage = shouldIncludeGlobalStorageInClone();
  const excludePaths = getCloneExcludePaths();

  // VS Code user data layout (macOS stable):
  // - User/ (settings, globalStorage, workspaceStorage)
  // - CachedData/, logs/, etc.

  if (mode === "full") {
    await copyDirSkippingSpecialFiles(srcUserDataDir, destUserDataDir, {
      rootSrcDir: srcUserDataDir,
      excludePaths,
      logPrefix,
    });
    return;
  }

  // minimal mode:
  // - Copy User/ directory, but only allowlist subfolders within User/globalStorage
  // - Skip bulky caches/logs/crash dirs (already handled by shouldSkipUserDataEntry)
  const userSrc = path.join(srcUserDataDir, "User");
  const userDest = path.join(destUserDataDir, "User");
  await fs.promises.mkdir(userDest, { recursive: true });

  // Copy everything in User/ except globalStorage directories (handled separately).
  const userEntries = await fs.promises.readdir(userSrc, {
    withFileTypes: true,
  });
  await Promise.all(
    userEntries.map(async (entry) => {
      if (entry.name === "globalStorage") return;
      const srcPath = path.join(userSrc, entry.name);
      const destPath = path.join(userDest, entry.name);

      const rel = path.posix.join("User", entry.name);
      if (shouldExcludeRelativePath(rel, excludePaths)) {
        if (logPrefix) {
          console.log(`${logPrefix} minimal clone: excluded '${rel}'`);
        }
        return;
      }

      if (entry.isDirectory()) {
        await copyDirSkippingSpecialFiles(srcPath, destPath, {
          rootSrcDir: srcUserDataDir,
          excludePaths,
          logPrefix,
        });
      } else if (entry.isSymbolicLink()) {
        const link = await fs.promises.readlink(srcPath);
        await fs.promises.symlink(link, destPath);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(srcPath, destPath);
      }
    })
  );

  if (!includeGlobalStorage) {
    // Keep the directory structure stable, but omit globalStorage content entirely.
    // This can be useful to validate whether auth state truly requires globalStorage
    // for a given environment.
    await fs.promises.mkdir(path.join(userDest, "globalStorage"), {
      recursive: true,
    });
    if (logPrefix) {
      console.log(
        `${logPrefix} minimal clone: skipping User/globalStorage (PW_VSCODE_CLONE_INCLUDE_GLOBAL_STORAGE=0)`
      );
    }
    return;
  }

  // Now copy User/globalStorage, but only root files + allowlisted extension dirs.
  const gsSrc = path.join(userSrc, "globalStorage");
  const gsDest = path.join(userDest, "globalStorage");
  await fs.promises.mkdir(gsDest, { recursive: true });
  const gsEntries = await fs.promises.readdir(gsSrc, { withFileTypes: true });
  await Promise.all(
    gsEntries.map(async (entry) => {
      const srcPath = path.join(gsSrc, entry.name);
      const destPath = path.join(gsDest, entry.name);

      const rel = path.posix.join("User", "globalStorage", entry.name);
      if (shouldExcludeRelativePath(rel, excludePaths)) {
        if (logPrefix) {
          console.log(`${logPrefix} minimal clone: excluded '${rel}'`);
        }
        return;
      }

      if (entry.isDirectory()) {
        if (!allowlist.has(entry.name)) return;
        await copyDirSkippingSpecialFiles(srcPath, destPath, {
          rootSrcDir: srcUserDataDir,
          excludePaths,
          logPrefix,
        });
        return;
      }
      if (entry.isSymbolicLink()) {
        const link = await fs.promises.readlink(srcPath);
        await fs.promises.symlink(link, destPath);
        return;
      }
      if (entry.isFile()) {
        await fs.promises.copyFile(srcPath, destPath);
      }
    })
  );
}

async function copyDirSkippingSpecialFiles(
  srcDir: string,
  destDir: string,
  opts: {
    rootSrcDir: string;
    excludePaths: string[];
    logPrefix?: string;
  }
) {
  const relFromRoot = path
    .relative(opts.rootSrcDir, srcDir)
    .replace(/\\/g, "/");
  if (
    relFromRoot &&
    shouldExcludeRelativePath(
      path.posix.normalize(relFromRoot),
      opts.excludePaths
    )
  ) {
    if (opts.logPrefix) {
      console.log(`${opts.logPrefix} excluded dir '${relFromRoot}'`);
    }
    return;
  }

  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  await fs.promises.mkdir(destDir, { recursive: true });

  const t0 = Date.now();
  let copiedFiles = 0;
  let copiedDirs = 0;
  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      const rel = path.relative(opts.rootSrcDir, srcPath).replace(/\\/g, "/");
      if (
        rel &&
        shouldExcludeRelativePath(path.posix.normalize(rel), opts.excludePaths)
      ) {
        if (opts.logPrefix) {
          console.log(`${opts.logPrefix} excluded '${rel}'`);
        }
        return;
      }

      // Avoid copying VS Code's runtime socket/lock artifacts.
      if (entry.name.endsWith(".sock")) return;

      if (shouldSkipUserDataEntry(entry.name)) return;

      if (entry.isDirectory()) {
        copiedDirs++;
        await copyDirSkippingSpecialFiles(srcPath, destPath, opts);
        return;
      }

      if (entry.isSymbolicLink()) {
        const link = await fs.promises.readlink(srcPath);
        await fs.promises.symlink(link, destPath);
        return;
      }

      if (entry.isFile()) {
        await fs.promises.copyFile(srcPath, destPath);
        copiedFiles++;
        return;
      }

      // Skip sockets, FIFOs, devices, etc.
    })
  );

  if (opts.logPrefix) {
    const dtMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `${opts.logPrefix} copied ${copiedFiles} file(s), ${copiedDirs} dir(s) from ${srcDir} in ${dtMs}ms`
    );
  }
}

function resolveCloneCacheDir(): string | undefined {
  // Deprecated: clone caching removed. Always clone into a fresh temp directory.
  return undefined;
}

function resolveDefaultVSCodeUserDataDir(explicitExecutablePath?: string) {
  const isInsiders = /insiders/i.test(explicitExecutablePath ?? "");
  const platform = os.platform();

  if (platform === "darwin") {
    // VS Code (stable): ~/Library/Application Support/Code
    // VS Code Insiders: ~/Library/Application Support/Code - Insiders
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      isInsiders ? "Code - Insiders" : "Code"
    );
  }

  if (platform === "win32") {
    // VS Code (stable): %APPDATA%\Code
    // VS Code Insiders: %APPDATA%\Code - Insiders
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error(
        "PW_VSCODE_CLONE_USER_DATA_FROM=default requires APPDATA to be set on Windows."
      );
    }
    return path.join(appData, isInsiders ? "Code - Insiders" : "Code");
  }

  // Linux
  // VS Code (stable): ~/.config/Code
  // VS Code Insiders: ~/.config/Code - Insiders
  return path.join(
    os.homedir(),
    ".config",
    isInsiders ? "Code - Insiders" : "Code"
  );
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
  vscodeExecutablePath: [undefined, { option: true, scope: "worker" }],
  vscodeProfile: [undefined, { option: true, scope: "worker" }],
  cloneUserDataDirFrom: [undefined, { option: true, scope: "worker" }],
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
          const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(
            explicitExecutablePath
          );
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
      const installPath = await downloadAndUnzipVSCode({
        cachePath: installBasePath,
        version: vscodeVersion,
      });
      const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(installPath);

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
        extensions,
        vscodeProfile,
        cloneUserDataDirFrom,
        extensionsDir,
        userDataDir,
      },
      use,
      testInfo
    ) => {
      const { installPath, cachePath } = _vscodeInstall;

      const effectiveProfile = vscodeProfile ?? process.env.PW_VSCODE_PROFILE;

      // For demo/recording runs, you can clone an existing signed-in profile into
      // this run's temp directory. This both:
      // 1) avoids VS Code single-instance handoff, and
      // 2) preserves auth state so Copilot/GitHub can be available.
      const cloneFromRaw =
        cloneUserDataDirFrom ?? process.env.PW_VSCODE_CLONE_USER_DATA_FROM;
      const cloneFrom =
        cloneFromRaw === "default"
          ? resolveDefaultVSCodeUserDataDir(installPath)
          : cloneFromRaw;

      // Always clone into a fresh directory for each run to avoid state bleed
      // and to make it easier to iteratively narrow the minimal set of files
      // required for sign-in behavior.
      const clonedUserDataDir = cloneFrom
        ? path.join(cachePath, "user-data")
        : undefined;
      if (cloneFrom) {
        if (!fs.existsSync(cloneFrom)) {
          throw new Error(
            `PW_VSCODE_CLONE_USER_DATA_FROM path does not exist: ${cloneFrom}`
          );
        }

        const logPrefix = "[pw-vscode]";
        // eslint-disable-next-line no-console
        console.log(
          `${logPrefix} cloning user data from '${cloneFrom}' to '${clonedUserDataDir}'`
        );

        const t0 = Date.now();
        await fs.promises.mkdir(clonedUserDataDir!, { recursive: true });
        // Copy can be large; keep it simple and explicit.
        // We can't rely on fs.cp because VS Code profiles can include socket files.
        await copyVSCodeUserDataDir(cloneFrom, clonedUserDataDir!, logPrefix);
        // eslint-disable-next-line no-console
        console.log(
          `${logPrefix} clone completed in ${
            Date.now() - t0
          }ms (dest='${clonedUserDataDir}')`
        );

        // Always sanitize cloned user data.
        await sanitizeClonedUserDataDir(clonedUserDataDir!);
      }

      const effectiveUserDataDir = userDataDir ?? clonedUserDataDir;

      // Playwright's Electron launcher needs the actual executable.
      // On macOS, @vscode/test-electron provides an install directory containing
      // `Visual Studio Code.app`, so we must point at `.../Contents/MacOS/Electron`.
      let electronExecutablePath = installPath;
      if (os.platform() === "darwin") {
        // Some versions return the Electron binary directly.
        if (fs.existsSync(installPath)) {
          const stat = fs.statSync(installPath);
          if (stat.isFile() && path.basename(installPath) === "Electron") {
            electronExecutablePath = installPath;
          } else {
            const appBundlePath = installPath.endsWith(".app")
              ? installPath
              : path.join(installPath, "Visual Studio Code.app");
            const candidate = path.join(
              appBundlePath,
              "Contents",
              "MacOS",
              "Electron"
            );
            if (!fs.existsSync(candidate)) {
              throw new Error(
                `VS Code Electron executable not found at expected path: ${candidate}. ` +
                  `Resolved installPath: ${installPath}`
              );
            }
            electronExecutablePath = candidate;
          }
        }
      }

      // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
      // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
      const env = { ...process.env } as Record<string, string>;
      for (const prop in env) {
        if (/^VSCODE_/i.test(prop)) delete env[prop];
      }

      const electronApp = await _electron.launch({
        executablePath: electronExecutablePath,
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
          ...(effectiveProfile ? ["--profile", effectiveProfile] : []),
          // Only pin dirs when the caller explicitly asked for them OR when we
          // installed extensions into a temp dir for this run.
          ...(extensions || extensionsDir
            ? [
                `--extensions-dir=${
                  extensionsDir ?? path.join(cachePath, "extensions")
                }`,
              ]
            : []),
          ...(effectiveUserDataDir
            ? [`--user-data-dir=${effectiveUserDataDir}`]
            : []),
          // `--extensionTestsPath=${path.join(__dirname, "injected", "index")}`,
          ...(extensionDevelopmentPath
            ? [`--extensionDevelopmentPath=${extensionDevelopmentPath}`]
            : []),
          baseDir,
        ],
      });

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

      // If VS Code crashes/exits early, closing the Electron application can throw.
      // We still want to copy whatever logs exist to the test output for diagnosis.
      let closeError: unknown;
      try {
        await electronApp.close();
      } catch (e) {
        closeError = e;
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

      const logPath = path.join(cachePath, "user-data", "logs");
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
        await fs.promises.rm(tempDir, { recursive: true });
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
