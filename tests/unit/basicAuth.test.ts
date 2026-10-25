// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from '@/proxy';
import { basicAuthDenial, getAuthenticatedUser, getBasicAuthConfig } from '@/src/server/basicAuth';

const authorize = (value = 'operator:test-password') =>
  `Basic ${Buffer.from(value).toString('base64')}`;
const request = (authorization?: string, path = '/') =>
  new NextRequest(`http://localhost${path}`, {
    headers: authorization ? { Authorization: authorization } : undefined
  });
const enableAuth = () => {
  vi.stubEnv('BASIC_AUTH_USER', 'operator');
  vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
};

afterEach(() => vi.unstubAllEnvs());

describe('Basic authentication configuration', () => {
  it('is disabled when both credentials are absent or blank', () => {
    expect(getBasicAuthConfig({})).toEqual({ mode: 'disabled' });
    expect(getBasicAuthConfig({ BASIC_AUTH_USER: '', BASIC_AUTH_PASSWORD: '' })).toEqual({
      mode: 'disabled'
    });
    vi.stubEnv('BASIC_AUTH_USER', '');
    vi.stubEnv('BASIC_AUTH_PASSWORD', '');
    expect(basicAuthDenial(request())).toBeUndefined();
  });

  it.each([
    { BASIC_AUTH_USER: 'operator' },
    { BASIC_AUTH_PASSWORD: 'test-password' },
    { BASIC_AUTH_USER: 'operator:extra', BASIC_AUTH_PASSWORD: 'test-password' },
    { BASIC_AUTH_USER: 'operator\n', BASIC_AUTH_PASSWORD: 'test-password' },
    { BASIC_AUTH_USER: 'operator', BASIC_AUTH_PASSWORD: 'test\npassword' }
  ])('rejects an incomplete or invalid config: %j', (env) => {
    expect(getBasicAuthConfig(env)).toEqual({ mode: 'invalid' });
  });

  it('fails closed at runtime when only one credential is set', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', '');
    const denied = basicAuthDenial(request(authorize()));
    expect(denied?.status).toBe(503);
    expect(await denied?.text()).not.toContain('operator');
  });
});

describe('Basic credentials', () => {
  it('accepts the exact configured pair and a case-insensitive scheme', () => {
    enableAuth();
    expect(getAuthenticatedUser(request(authorize()))).toBe('operator');
    expect(getAuthenticatedUser(request(authorize().replace('Basic', 'basic')))).toBe('operator');
    expect(basicAuthDenial(request(authorize()))).toBeUndefined();
  });

  it('supports UTF-8 and colons in passwords without trimming secrets', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'équipe');
    vi.stubEnv('BASIC_AUTH_PASSWORD', '  test:password:é  ');
    expect(getAuthenticatedUser(request(authorize('équipe:  test:password:é  ')))).toBe('équipe');
    expect(getAuthenticatedUser(request(authorize('équipe:test:password:é')))).toBeUndefined();
  });

  it.each([
    undefined,
    authorize('other:test-password'),
    authorize('operator:wrong'),
    authorize('operator'),
    'Bearer test-password',
    'Basic !!!',
    'Basic A',
    'Basic ////',
    `Basic ${'A'.repeat(8200)}`
  ])('rejects missing, incorrect, or malformed credentials', async (header) => {
    enableAuth();
    expect(getAuthenticatedUser(request(header))).toBeUndefined();
    const denied = basicAuthDenial(request(header));
    expect(denied?.status).toBe(401);
    expect(denied?.headers.get('WWW-Authenticate')).toBe(
      'Basic realm="Signal STT", charset="UTF-8"'
    );
    expect(denied?.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await denied?.text()).toBe('{"error":"Authentication required."}');
  });
});

describe('Proxy coverage', () => {
  it.each([
    '/',
    '/api/transcribe',
    '/api/realtime/call',
    '/api/health/extra',
    '/_next/static/app.js'
  ])('protects %s', (path) => {
    enableAuth();
    expect(proxy(request(undefined, path)).status).toBe(401);
    expect(proxy(request(authorize(), path)).headers.get('x-middleware-next')).toBe('1');
  });

  it('allows the exact health endpoint even when auth is misconfigured', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', '');
    expect(proxy(request(undefined, '/api/health')).headers.get('x-middleware-next')).toBe('1');
  });
});

describe('authenticated browser mutations', () => {
  const mutation = (headers: Record<string, string> = {}) =>
    new NextRequest('http://localhost/api/transcribe', {
      method: 'POST',
      headers: { authorization: authorize(), ...headers }
    });

  it.each([
    { origin: 'https://foreign.example' },
    { origin: 'null' },
    { origin: 'not-a-url' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'http://localhost:9000' }
  ])('rejects cross-site or opaque browser requests: %j', (headers) => {
    enableAuth();
    expect(basicAuthDenial(mutation(headers))?.status).toBe(403);
    expect(proxy(mutation(headers)).status).toBe(403);
  });

  it('permits same-origin requests and credentialed CLI requests without Origin', () => {
    enableAuth();
    expect(
      basicAuthDenial(mutation({ origin: 'http://localhost', 'sec-fetch-site': 'same-origin' }))
    ).toBeUndefined();
    expect(basicAuthDenial(mutation())).toBeUndefined();
  });

  it('supports TLS-terminating reverse proxies that preserve Host', () => {
    enableAuth();
    expect(
      basicAuthDenial(mutation({ origin: 'https://stt.example.com', host: 'stt.example.com' }))
    ).toBeUndefined();
    expect(
      basicAuthDenial(
        mutation({ origin: 'https://foreign.example', 'x-forwarded-host': 'foreign.example' })
      )?.status
    ).toBe(403);
  });

  it('leaves the default unauthenticated mode unchanged', () => {
    vi.stubEnv('BASIC_AUTH_USER', '');
    vi.stubEnv('BASIC_AUTH_PASSWORD', '');
    expect(basicAuthDenial(mutation({ origin: 'https://foreign.example' }))).toBeUndefined();
  });
});
