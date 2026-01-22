import * as net from "node:net";
import { WebSocket } from "ws";
import { VSCodeTestServer } from "./serverCore";
import type { RpcTransport } from "../rpcTransport";

// Entry point passed to VS Code via --extensionTestsPath.
// This runs inside the VS Code extension host process.
export async function run() {
  const transport = (process.env.PW_VSCODE_TEST_TRANSPORT ?? "ws").trim();
  if (transport !== "ws" && transport !== "pipe") {
    throw new Error(
      `PW_VSCODE_TEST_TRANSPORT must be 'ws' or 'pipe'; got '${transport}'.`
    );
  }

  const connectTimeoutMs = 30_000;

  if (transport === "ws") {
    const url = process.env.PW_VSCODE_TEST_WS_URL;
    if (!url) {
      throw new Error(
        "PW_VSCODE_TEST_WS_URL was not set. The Playwright harness must provide the WebSocket server URL for the extension host test server to connect to."
      );
    }

    process.stderr.write(`VSCodeTestServer connecting (ws) to ${url}\n`);
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
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timeout);
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

  process.stderr.write(`VSCodeTestServer connecting (pipe) to ${pipePath}\n`);
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
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  await runPromise;
}
