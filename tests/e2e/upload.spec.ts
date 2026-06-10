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
