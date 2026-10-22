import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SHARED_CLIENT_ID,
  assertRateLimit,
  getClientId,
  getSafetyIdentifier,
  resetRateLimits
} from '@/src/server/rateLimit';

const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/transcribe', { method: 'POST', headers });

afterEach(() => {
  resetRateLimits();
  vi.unstubAllEnvs();
});

describe('client identification', () => {
  it('ignores client-supplied forwarding headers unless TRUST_PROXY is enabled', () => {
    const spoofed = request({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.10' });
    expect(getClientId(spoofed, { trustProxy: false })).toBe(SHARED_CLIENT_ID);
  });

  it('uses the right-most X-Forwarded-For entry when behind a trusted proxy', () => {
    const viaProxy = request({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' });
    expect(getClientId(viaProxy, { trustProxy: true })).toBe('198.51.100.7');
    expect(getClientId(request({ 'x-real-ip': '198.51.100.8' }), { trustProxy: true })).toBe(
      '198.51.100.8'
    );
    expect(getClientId(request(), { trustProxy: true })).toBe(SHARED_CLIENT_ID);
  });

  it('reads TRUST_PROXY from the environment', () => {
    const viaProxy = request({ 'x-forwarded-for': '198.51.100.7' });
    expect(getClientId(viaProxy)).toBe(SHARED_CLIENT_ID);
    vi.stubEnv('TRUST_PROXY', 'true');
    expect(getClientId(viaProxy)).toBe('198.51.100.7');
  });
});

describe('rate limiting', () => {
  it('cannot be bypassed by rotating X-Forwarded-For without TRUST_PROXY', () => {
    vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '2');
    assertRateLimit(request({ 'x-forwarded-for': '10.0.0.1' }), 'test');
    assertRateLimit(request({ 'x-forwarded-for': '10.0.0.2' }), 'test');
    expect(() => assertRateLimit(request({ 'x-forwarded-for': '10.0.0.3' }), 'test')).toThrow(
      /Too many requests/
    );
  });

  it('keys buckets per proxy-reported client when TRUST_PROXY is enabled', () => {
    vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '1');
    vi.stubEnv('TRUST_PROXY', 'true');
    assertRateLimit(request({ 'x-forwarded-for': '10.0.0.1' }), 'test');
    assertRateLimit(request({ 'x-forwarded-for': '10.0.0.2' }), 'test');
    expect(() => assertRateLimit(request({ 'x-forwarded-for': '10.0.0.1' }), 'test')).toThrow();
  });
});

describe('safety identifier', () => {
  const viaProxy = request({ 'x-forwarded-for': '198.51.100.7' });

  it('never contains the raw client IP', () => {
    const id = getSafetyIdentifier(viaProxy, { trustProxy: true, salt: 'test-salt' });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain('198.51.100.7');
  });

  it('is stable for a given salt and differs across salts and clients', () => {
    const a = getSafetyIdentifier(viaProxy, { trustProxy: true, salt: 's1' });
    expect(getSafetyIdentifier(viaProxy, { trustProxy: true, salt: 's1' })).toBe(a);
    expect(getSafetyIdentifier(viaProxy, { trustProxy: true, salt: 's2' })).not.toBe(a);
    const other = request({ 'x-forwarded-for': '198.51.100.8' });
    expect(getSafetyIdentifier(other, { trustProxy: true, salt: 's1' })).not.toBe(a);
  });

  it('is omitted when clients cannot be distinguished', () => {
    expect(getSafetyIdentifier(viaProxy, { trustProxy: false, salt: 's1' })).toBeUndefined();
  });

  it('works with the per-process random salt when none is configured', () => {
    vi.stubEnv('TRUST_PROXY', 'true');
    expect(getSafetyIdentifier(viaProxy)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('removed endpoints', () => {
  it('no longer ships the unauthenticated realtime client-secret route', () => {
    expect(existsSync(join(process.cwd(), 'app/api/realtime/session/route.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'app/api/realtime/call/route.ts'))).toBe(true);
  });
});
