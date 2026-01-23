import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocket } from "ws";
import { VSCodeTestServer } from "./serverCore";
import type { RpcTransport } from "../rpcTransport";

function isTraceEnabled(): boolean {
  const raw = process.env.PW_VSCODE_TEST_TRACE;
  if (!raw) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function trace(message: string) {
  if (!isTraceEnabled()) {
    return;
  }

  const line = `[VSCodeTestServer][${new Date().toISOString()}][pid=${process.pid}] ${message}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // ignore
  }

  const filePath = process.env.PW_VSCODE_TEST_TRACE_FILE;
  if (!filePath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, "utf8");
  } catch {
    // ignore
  }
}

// Entry point passed to VS Code via --extensionTestsPath.
// This runs inside the VS Code extension host process.
export async function run() {
  const transport = (process.env.PW_VSCODE_TEST_TRANSPORT ?? "pipe").trim();
  if (transport !== "ws" && transport !== "pipe") {
    throw new Error(
      `PW_VSCODE_TEST_TRANSPORT must be 'ws' or 'pipe'; got '${transport}'.`
    );
  }

  trace(
    `Starting. transport=${transport}, node=${process.version}, platform=${process.platform}, traceFile=${String(
      process.env.PW_VSCODE_TEST_TRACE_FILE
    )}`
  );

  const connectTimeoutMs = 30_000;

  if (transport === "ws") {
    const url = process.env.PW_VSCODE_TEST_WS_URL;
    if (!url) {
      throw new Error(
        "PW_VSCODE_TEST_WS_URL was not set. The Playwright harness must provide the WebSocket server URL for the extension host test server to connect to."
      );
    }

    trace(`Connecting (ws) to ${url}`);
    const ws = new WebSocket(url);
    const rpcTransport: RpcTransport = { kind: "ws", socket: ws };

    // IMPORTANT: Begin listening immediately. The harness may begin sending
    // requests as soon as the connection is established.
    const runPromise = new VSCodeTestServer(rpcTransport).run();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out connecting (ws) to ${url}`)),
        connectTimeoutMs
      );
      ws.once("open", () => {
        clearTimeout(timeout);
        trace(`Connected (ws) to ${url}`);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timeout);
        trace(`Connect error (ws): ${String(err)}`);
        reject(err);
      });
    });

    await runPromise;
    return;
  }

  const pipePath = process.env.PW_VSCODE_TEST_PIPE_PATH;
  if (!pipePath) {
    throw new Error(
      "PW_VSCODE_TEST_PIPE_PATH was not set. The Playwright harness must provide the named pipe/Unix socket path for the extension host test server to connect to when PW_VSCODE_TEST_TRANSPORT=pipe."
    );
  }

  if (process.platform !== "win32") {
    trace(`Connecting (pipe) to ${pipePath} (exists=${fs.existsSync(pipePath)})`);
  } else {
    trace(`Connecting (pipe) to ${pipePath}`);
  }
  const socket = net.connect(pipePath);
  const rpcTransport: RpcTransport = { kind: "pipe", socket };

  const runPromise = new VSCodeTestServer(rpcTransport).run();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out connecting (pipe) to ${pipePath}`)),
      connectTimeoutMs
    );
    socket.once("connect", () => {
      clearTimeout(timeout);
      trace(`Connected (pipe) to ${pipePath}`);
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timeout);
      trace(`Connect error (pipe): ${String(err)}`);
      reject(err);
    });
  });

  await runPromise;
}
