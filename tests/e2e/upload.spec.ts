import { expect, test } from '@playwright/test';

test('upload mode sends a file and displays transcript text', async ({ page }) => {
  await page.route('**/api/transcribe', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          text: 'Mocked upload transcript.',
          language: 'en',
          model: 'gpt-4o-mini-transcribe',
          createdAt: '2026-06-10T00:00:00.000Z',
          segments: []
        }
      })
    });
  });

  await page.goto('/');
  await page.getByRole('tab', { name: /file upload/i }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sample.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('fake audio')
  });
  await page.getByRole('button', { name: /transcribe file/i }).click();

  await expect(page.getByLabel('Transcript text')).toHaveValue('Mocked upload transcript.');
});

test('live mode does not start local recording fallback for server-side OpenAI failures', async ({
  context,
  page
}) => {
  await context.grantPermissions(['microphone']);
  await page.route('**/api/realtime/call**', async (route) => {
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'UPSTREAM_ERROR',
          message:
            'Could not establish realtime transcription session. OpenAI returned HTTP 500. Verify the OpenAI project has active billing and access to realtime transcription.',
          retryable: true,
          upstreamStatus: 500
        }
      })
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Start$/ }).click();

  await expect(page.getByText(/^error$/i)).toBeVisible();
  await expect(page.getByText(/Verify the OpenAI project has active billing/)).toBeVisible();
  await expect(page.getByText(/Recording locally in this tab/)).toHaveCount(0);
});
