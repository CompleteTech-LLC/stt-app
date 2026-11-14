import { request as httpRequest } from 'node:http';

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

test('missing canonical origin fails closed over HTTP and in the browser', async ({
  browser,
  request
}) => {
  const unconfigured = 'http://127.0.0.1:3110';
  const response = await request.post(`${unconfigured}/api/realtime/call`, {
    headers: {
      authorization,
      origin: unconfigured,
      host: '127.0.0.1:3110',
      'x-forwarded-host': '127.0.0.1:3110',
      'x-forwarded-proto': 'http'
    },
    data: 'invalid'
  });
  expect(response.status()).toBe(503);
  const context = await browser.newContext({
    httpCredentials: { username: 'synthetic-user', password: 'synthetic-password' }
  });
  try {
    const page = await context.newPage();
    expect((await page.goto(unconfigured))?.status()).toBe(200);
    expect(
      await page.evaluate(async () => {
        const response = await fetch('/api/realtime/call', { method: 'POST', body: 'invalid' });
        return response.status;
      })
    ).toBe(503);
  } finally {
    await context.close();
  }
});

test('framework routing headers cannot bypass authentication', async ({ request }) => {
  const attempts: Record<string, string>[] = [
    { 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy' },
    { 'x-invoke-path': '/api/health', 'x-invoke-query': '{}' },
    { 'x-matched-path': '/api/health', 'x-now-route-matches': '1' },
    { 'x-middleware-rewrite': '/api/health' },
    { rsc: '1', 'next-router-state-tree': '%5B%5D' }
  ];
  for (const headers of attempts) {
    expect((await request.get(`${origin}/`, { headers })).status()).toBe(401);
  }
  for (const path of ['/_next/static/nonexistent.js', '/?_rsc=synthetic']) {
    expect((await request.get(`${origin}${path}`, { headers: { rsc: '1' } })).status()).toBe(401);
  }
  const forged = await request.post(`${origin}/api/realtime/call`, {
    headers: {
      authorization,
      origin: 'http://attacker.example',
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'http'
    },
    data: 'invalid'
  });
  expect(forged.status()).toBe(403);
});

// Node's HTTP client preserves the request target; browser and URL clients normalize it.
test('normalized health paths do not expose protected routes', async () => {
  const get = (path: string) =>
    new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: 3108, path }, (response) => {
        response.resume();
        resolve({ status: response.statusCode || 0, location: response.headers.location });
      });
      req.on('error', reject);
      req.end();
    });
  expect((await get('/api/health')).status).toBe(200);
  for (const path of [
    '/api/%68ealth',
    '/api/health%2fextra',
    '/api/health/extra',
    '/api/health.json'
  ]) {
    expect((await get(path)).status).toBe(401);
  }
  for (const path of ['/api//health', '/api/health/']) {
    const response = await get(path);
    expect([401, 308]).toContain(response.status);
    if (response.status === 308) expect(response.location).toBe('/api/health');
  }
});
