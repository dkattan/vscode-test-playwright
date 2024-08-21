import { defineConfig } from '@playwright/test';
import path from 'path';
import type { VSCodeTestOptions, VSCodeWorkerOptions } from 'vscode-test-playwright';

export default defineConfig<VSCodeTestOptions, VSCodeWorkerOptions>({
  testDir: './tests',
  maxFailures: 1,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    trace: 'off',
    vscodeTrace: 'on',
    extensionDevelopmentPath: path.join(__dirname, 'tests', 'extension')
  },
  projects: [
    {
      name: 'insiders',
      use: {
        vscodeVersion: 'insiders',
      },
      // Keep upstream tests as-is; exclude Copilot Chat repro.
      testIgnore: /copilotChat\.spec\.ts/,
    },
    {
      name: 'release',
      use: {
        vscodeVersion: '1.92.2',
      },
      // Keep upstream tests as-is; exclude Copilot Chat repro.
      testIgnore: /copilotChat\.spec\.ts/,
    },
    {
      // Experimental repro target: mimic the demo repo's setup.
      // - stable VS Code
      // - marketplace Copilot extensions installed
      // - open a real workspace
      name: 'stable-with-copilot-chat',
      use: {
        vscodeVersion: 'stable',
        vscodeTrace: 'off',
        extensions: ['github.copilot', 'github.copilot-chat'],
        baseDir: path.join(
          __dirname,
          'tests',
          'workspaces',
          'copilot-chat',
          'copilot-chat.code-workspace'
        ),
      },
      // Only run the Copilot Chat repro test in this project.
      testMatch: /copilotChat\.spec\.ts/,
    },
  ],
});
