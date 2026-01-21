# vscode-test-playwright

Playwright Test fixtures for launching **Visual Studio Code (Electron)** and interacting with the **VS Code extension host** from your tests.

This package wires up:

- a Playwright `_electron` launch of VS Code (downloaded via `@vscode/test-electron` or using an existing install)
- an injected “extension tests” entrypoint (`--extensionTestsPath=...`) that starts a small WebSocket JSON-RPC server inside VS Code
- a Node-side client that lets your Playwright tests call `vscode.*` APIs, evaluate functions in the VS Code process, and keep remote objects alive via handles.

It’s intended for **VS Code integration testing** (extensions, webviews, commands, editor interactions) while still benefiting from Playwright’s runner, reporting, retries, and trace tooling.

## What you get

- ✅ Launch VS Code **release**, **insiders**, or **stable** via `@vscode/test-electron`
- ✅ Optionally launch a **user-provided VS Code install** (`vscodeExecutablePath` / `PW_VSCODE_EXECUTABLE_PATH`)
- ✅ Install extensions for a run (e.g. `github.copilot`, `github.copilot-chat`) via `--install-extension`
- ✅ A `test` fixture with helpers:
  - `evaluateInVSCode(...)` — run code against the `vscode` API in the extension host
  - `evaluateHandleInVSCode(...)` — return a _remote handle_ to a VS Code object
  - `vscode.commands.executeCommand(...)` convenience wrapper
- ✅ Remote handles support `evaluate(...)`, `evaluateHandle(...)`, `release(...)`
- ✅ Remote `EventEmitter` handles support `addListener(...)` / `removeListener(...)`

## Install

```sh
npm install
```

This repo builds TypeScript to `dist/` as part of `npm test`.

If you’re consuming this package from another repo, install it as a dependency (published name: `vscode-test-playwright`):

```sh
npm install --save-dev vscode-test-playwright
```

## Quick start

### 1) Create `playwright.config.ts`

Type the Playwright config with the provided option types:

```ts
import { defineConfig } from "@playwright/test";
import type {
  VSCodeTestOptions,
  VSCodeWorkerOptions,
} from "vscode-test-playwright";
import path from "path";

export default defineConfig<VSCodeTestOptions, VSCodeWorkerOptions>({
  testDir: "./tests",
  workers: 1,
  use: {
    // A directory (or .code-workspace) to open in VS Code.
    baseDir: path.join(__dirname, "tests", "workspaces", "basic"),

    // Optional: for extension development tests.
    // extensionDevelopmentPath: path.join(__dirname, 'path-to-your-extension'),

    // VS Code version to download via @vscode/test-electron.
    vscodeVersion: "insiders",

    // Optional: install extensions for this run.
    // extensions: ['github.copilot', 'github.copilot-chat'],

    // Extra tracing that focuses on VS Code-side calls (separate from Playwright trace).
    vscodeTrace: "on",
  },
});
```

### 2) Write a test

```ts
import { test, expect } from "vscode-test-playwright";

test("can execute a VS Code command", async ({ vscode }) => {
  // Runs inside VS Code extension host.
  await vscode.commands.executeCommand("workbench.action.showCommands");

  expect(true).toBe(true);
});

test("can evaluate in VS Code", async ({ evaluateInVSCode }) => {
  const version = await evaluateInVSCode((vscode) => vscode.version);
  expect(version).toBeTruthy();
});
```

### 3) Run

```sh
npm test
```

The default Playwright HTML report is written to `playwright-report/`.

## Fixtures

The exported `test` is a Playwright Test instance extended with VS Code-specific fixtures.

### Worker-scoped options (configure via `use:`)

- `vscodeVersion: string`
  - Example values: `'insiders'`, `'stable'`, or a specific version string.
- `vscodeExecutablePath?: string`
  - Use an existing VS Code install instead of downloading one.
  - On macOS you can pass either the `.app` path (it will be normalized) or the Electron binary inside the bundle.
- `extensions?: string | string[]`
  - Marketplace extension IDs to install for the test run (e.g. `github.copilot-chat`).
- `extensionsDir?: string`
  - Where extensions are installed/loaded from.
- `userDataDir?: string`
  - User profile directory for VS Code.
- `vscodeTrace: 'off' | 'on' | 'retain-on-failure' | ...`
  - Uses Playwright tracing under the hood but records VS Code calls (evaluate/evaluateHandle) as custom steps.

### Test-scoped options

- `baseDir: string`
  - The folder (or workspace) to open in VS Code.
  - If you don’t provide one, a temporary directory is created.
- `extensionDevelopmentPath?: string`
  - Optional `--extensionDevelopmentPath=...` passed to VS Code.

### Runtime fixtures

- `electronApp`
  - Playwright `ElectronApplication` instance for the VS Code process.
- `workbox` / `page`
  - The first VS Code window as a Playwright `Page`.
- `context`
  - Playwright `BrowserContext`.
- `vscode`
  - Convenience wrapper currently exposing:
    - `vscode.commands.executeCommand(command, ...args)`
- `evaluateInVSCode(fn, arg?)`
  - Runs `fn(vscode, arg)` in the VS Code extension host.
- `evaluateHandleInVSCode(fn, arg?)`
  - Like `evaluateInVSCode`, but returns a handle that keeps the result alive across calls.

## Handles

`evaluateHandleInVSCode` returns a `VSCodeHandle<T>`.

- For normal objects, you get an `ObjectHandle<T>`:
  - `handle.evaluate(fn, arg?)`
  - `handle.evaluateHandle(fn, arg?)`
  - `handle.release({ dispose?: boolean })`

- If the result is a `vscode.EventEmitter<R>`, you get an `EventEmitterHandle<R>`:
  - `addListener(listener)`
  - `removeListener(listener)`

Notes:

- Functions are transmitted by `fn.toString()` and executed in VS Code using `new Function(...)`.
  - Prefer simple, self-contained functions.
  - Avoid capturing complex outer-scope variables.
- Arguments are JSON-serialized, with special support for passing other handles.
- Always `release()` handles you create (the fixture auto-releases handles returned from `evaluateHandleInVSCode` at the end of the test).

## Environment variables

Useful knobs when running locally or in CI:

- `PW_VSCODE_EXECUTABLE_PATH`
  - Alternate way to set `vscodeExecutablePath`.
- `PW_VSCODE_AUTO_DISCOVER=1`
  - Best-effort VS Code install auto-discovery (opt-in).
- `PW_VSCODE_DEBUG=1`
  - Enables verbose debug logging and mirrors VS Code stdout/stderr.
- `PW_VSCODE_WAIT_FOR_LINE_TIMEOUT_MS`
  - Timeout for waiting on VS Code to print the injected server URL.
- `PW_VSCODE_ISOLATE_EXTENSIONS_DIR`
  - Defaults to isolating extensions for determinism; set to `0` to opt out.
- `PW_TEST_DISABLE_TRACING`
  - Disables tracing capture logic.

## Linux notes

To run UI/Electron tests on Linux CI you typically need Xvfb and related system deps.

This repo provides:

- `npm run test:linux` — wrapper script intended for CI environments.

## Development

- `npm run build` — compile TypeScript to `dist/`
- `npm test` — build + run Playwright tests
- `npm run watch` — TypeScript watch mode

## How it works (high-level)

1. The Playwright worker fixture downloads or locates a VS Code build.
2. VS Code is launched via Playwright’s Electron support.
3. VS Code is started with `--extensionTestsPath=dist/injected/index`, which runs a tiny server in the extension host.
4. The Playwright side connects over WebSocket JSON-RPC and can:
   - call functions in the VS Code process (`evaluateInVSCode`)
   - return and manage remote objects via handles (`evaluateHandleInVSCode`)
   - subscribe to `EventEmitter` events

## Troubleshooting

- **VS Code exits before tests start**
  - Set `PW_VSCODE_DEBUG=1` and inspect `vscode-stdout`/`vscode-stderr` attachments under `test-results/`.
  - Ensure you’re not running with conflicting `VSCODE_*` environment variables.

- **Extension installation fails**
  - When using `vscodeExecutablePath`, this harness needs the VS Code CLI location to be resolvable.
  - Prefer pointing `vscodeExecutablePath` at the actual Electron binary on macOS if you run into CLI resolution issues.

- **Hangs waiting for server URL**
  - Increase `PW_VSCODE_WAIT_FOR_LINE_TIMEOUT_MS`.
