// Minimal VS Code extension used by this repo's Playwright integration tests.
// Kept as plain JS so tests don't depend on building a separate extension.

/** @typedef {import('vscode')} vscode */

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const vscode = require('vscode');

  context.subscriptions.push(
    vscode.commands.registerCommand('example.helloWorld', async () => {
      // Don't await: when no buttons are provided, the returned promise can
      // resolve only after the notification is dismissed, which makes
      // `evaluateInVSCode` hang and the Playwright test time out.
      void vscode.window.showInformationMessage('Hello World!');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('example.showView', async (_mode) => {
      const panel = vscode.window.createWebviewPanel(
        'example.showView',
        'Example View',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
        }
      );

      // VS Code webviews already involve an iframe nesting. The integration test
      // intentionally traverses two iframes to reach the rendered webview
      // document. So we must render the draggable/droppable elements directly
      // in the webview HTML (no extra iframe of our own).
      panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Example View</title>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    #draggable {
      width: 140px;
      padding: 10px;
      border: 1px solid #888;
      background: #e6f3ff;
      cursor: grab;
      user-select: none;
      display: inline-block;
    }
    #droppable {
      margin-top: 20px;
      width: 320px;
      height: 160px;
      border: 2px dashed #888;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fafafa;
    }
  </style>
</head>
<body>
  <div id="draggable" draggable="true">Drag me</div>
  <div id="droppable">Drop here</div>

  <script>
    const draggable = document.getElementById('draggable');
    const droppable = document.getElementById('droppable');

    draggable.addEventListener('dragstart', (e) => {
      try {
        e.dataTransfer.setData('text/plain', 'drag');
      } catch { /* no-op */ }
    });

    droppable.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    droppable.addEventListener('drop', (e) => {
      e.preventDefault();
      droppable.textContent = 'Drag into rectangle';
    });
  </script>
</body>
</html>`;
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
