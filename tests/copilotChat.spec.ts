import { expect, test } from 'vscode-test-playwright';

// Repro goal: exercise the same Copilot Chat UI flow as the demo repo.
// If this passes under ubuntu:full, we still have not reproduced the demo failure.

test('copilot chat submit roundtrip', async ({ workbox, vscode }) => {
  test.setTimeout(90_000);

  await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');

  const chatPanel = workbox.locator('#workbench\\.panel\\.chat');
  await expect(chatPanel).toBeVisible({ timeout: 30_000 });

  // Prefer codicon-based selectors for stability across label text and locale.
  const chatSendIcon = chatPanel.locator(
    'div.monaco-toolbar.chat-execute-toolbar a.action-label.codicon.codicon-send'
  );
  const chatStopIcon = chatPanel.locator(
    'div.monaco-toolbar.chat-execute-toolbar a.action-label.codicon.codicon-stop-circle'
  );

  // In headless/CI environments (especially under `act`), Copilot Chat is often
  // present but *unauthenticated*. In that state the chat input/submit controls
  // may be replaced by a sign-in call-to-action.
  // Note: this CTA is often in the top toolbar, not within the chat panel.
  const signInToUseAI = workbox.getByRole('button', {
    name: /sign in to use ai features/i,
  });

  // Tight waits: we only need to distinguish "unauthenticated" vs "ready to send".
  const initialState = await Promise.any([
    signInToUseAI
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => 'unauthenticated' as const),
    chatSendIcon
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => 'ready' as const),
  ]).catch(() => 'unknown' as const);

  if (initialState === 'unauthenticated') {
    await expect(signInToUseAI.first()).toBeVisible();
    return;
  }

  if (initialState === 'unknown') {
    throw new Error(
      'Copilot Chat UI did not show either the send control or the unauthenticated sign-in CTA within 15s.'
    );
  }

  await expect(chatSendIcon.first()).toBeVisible({ timeout: 30_000 });

  // Use explicit typing to avoid fragile input locators.
  await vscode.commands.executeCommand('type', {
    text: 'Say hello. (Repro: ignore content; we only care that chat processes a submit.)',
  });

  await vscode.commands.executeCommand('workbench.action.chat.submit');

  // If Copilot Chat starts processing, the icon flips to stop-circle.
  // If the system is misconfigured (e.g., crash/stack overflow), this step tends to be where it shows up.
  await expect(chatStopIcon.first()).toBeVisible({ timeout: 30_000 });

  // After submit, one of two things typically happens quickly:
  // - authenticated: the request completes and the send icon returns
  // - unauthenticated: the UI surfaces a sign-in CTA (and the request may never "complete")
  const afterSubmitState = await Promise.any([
    chatSendIcon
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'ready' as const),
    signInToUseAI
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'unauthenticated' as const),
  ]).catch(() => 'unknown' as const);

  if (afterSubmitState === 'unauthenticated') {
    await expect(signInToUseAI.first()).toBeVisible();
    return;
  }

  if (afterSubmitState === 'unknown') {
    throw new Error(
      'After submitting chat, neither the send control returned nor the unauthenticated sign-in CTA appeared within 30s.'
    );
  }

  await expect(chatSendIcon.first()).toBeVisible({ timeout: 30_000 });
});
