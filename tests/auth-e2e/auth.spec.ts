import { expect, test } from '@playwright/test';

const origin = 'http://127.0.0.1:3108';
const authorization = `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`;

test('HTTP proxy protects pages and APIs while leaving the exact health endpoint open', async ({
  request
}) => {
  const health = await request.get(`${origin}/api/health`);
  expect(health.status()).toBe(200);
  expect((await health.json()).ok).toBe(true);
  for (const path of ['/', '/api/realtime/call', '/api/health/extra']) {
    const response = await request.get(`${origin}${path}`);
    expect(response.status()).toBe(401);
    expect(response.headers()['www-authenticate']).toContain('Basic');
    expect(response.headers()['cache-control']).toContain('no-store');
  }
  expect((await request.get(origin, { headers: { authorization } })).status()).toBe(200);
  const rejected = await request.post(`${origin}/api/realtime/call`, {
    headers: { authorization, origin: 'http://127.0.0.1:3108', 'sec-fetch-site': 'cross-site' },
    data: 'v=0\r\n'
  });
  expect(rejected.status()).toBe(403);
});

test('browser reuses Basic credentials for same-origin API and blocks a foreign form', async ({
  browser
}) => {
  const context = await browser.newContext({
    httpCredentials: { username: 'synthetic-user', password: 'synthetic-password' }
  });
  try {
    const page = await context.newPage();
    expect((await page.goto(origin))?.status()).toBe(200);
    // An invalid offer exercises the actual API without ever reaching the provider.
    const sameOriginStatus = await page.evaluate(async () => {
      const response = await fetch('/api/realtime/call', { method: 'POST', body: 'invalid' });
      return response.status;
    });
    expect(sameOriginStatus).toBe(400);

    // Fulfil the foreign page locally; it still has a distinct browser origin.
    await page.route('http://localhost:3109/', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' })
    );
    await page.goto('http://localhost:3109/');
    const responsePromise = page.waitForResponse(
      (response) => response.url() === `${origin}/api/realtime/call`
    );
    await page.evaluate((target) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = `${target}/api/realtime/call`;
      form.appendChild(document.createElement('input'));
      document.body.appendChild(form);
      form.submit();
    }, origin);
    expect((await responsePromise).status()).toBe(403);
  } finally {
    await context.close();
  }
});
