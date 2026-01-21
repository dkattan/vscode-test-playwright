import { WebSocket } from "ws";
import { VSCodeTestServer } from "./serverCore";

// Entry point passed to VS Code via --extensionTestsPath.
// This runs inside the VS Code extension host process.
export async function run() {
  const url = process.env.PW_VSCODE_TEST_WS_URL;
  if (!url) {
    throw new Error(
      "PW_VSCODE_TEST_WS_URL was not set. The Playwright harness must provide the WebSocket server URL for the extension host test server to connect to."
    );
  }

  process.stderr.write(`VSCodeTestServer connecting to ${url}\n`);

  const ws = new WebSocket(url);

  // IMPORTANT: Begin listening immediately. The harness may begin sending
  // requests as soon as the connection is established.
  const runPromise = new VSCodeTestServer(ws).run();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out connecting to ${url}`)),
      30_000
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
}
