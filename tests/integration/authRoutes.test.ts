// @vitest-environment node

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as transcribe } from '@/app/api/transcribe/route';
import { POST as realtimeCall } from '@/app/api/realtime/call/route';
import { transcribeFile } from '@/src/server/fileTranscription';
import { createRealtimeCallAnswer } from '@/src/server/realtime';
import { resetRateLimits } from '@/src/server/rateLimit';

vi.mock('@/src/server/fileTranscription', () => ({ transcribeFile: vi.fn() }));
vi.mock('@/src/server/realtime', () => ({ createRealtimeCallAnswer: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetRateLimits();
});

describe('paid route authentication', () => {
  it.each([
    ['transcribe', transcribe],
    ['realtime/call', realtimeCall]
  ] as const)(
    'rejects authenticated cross-site %s POSTs before reading the body',
    async (path, handler) => {
      vi.stubEnv('BASIC_AUTH_USER', 'operator');
      vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
      vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
      const request = new NextRequest(`http://localhost/api/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`,
          origin: 'https://foreign.example',
          'sec-fetch-site': 'cross-site'
        }
      });
      const readForm = vi.spyOn(request, 'formData');
      const readText = vi.spyOn(request, 'text');
      expect((await handler(request)).status).toBe(403);
      expect(readForm).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(createRealtimeCallAnswer).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['transcribe', transcribe],
    ['realtime/call', realtimeCall]
  ] as const)(
    'denies direct %s route calls before reading the body or contacting OpenAI',
    async (path, handler) => {
      vi.stubEnv('BASIC_AUTH_USER', 'operator');
      vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
      const request = new NextRequest(`http://localhost/api/${path}`, { method: 'POST' });
      const readForm = vi.spyOn(request, 'formData');
      const readText = vi.spyOn(request, 'text');
      const response = await handler(request);
      expect(response.status).toBe(401);
      expect(readForm).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(createRealtimeCallAnswer).not.toHaveBeenCalled();
    }
  );

  it('lets valid credentials reach realtime processing with a hashed account id', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.mocked(createRealtimeCallAnswer).mockResolvedValue({ sdp: 'v=0\r\n', model: 'test-model' });
    const response = await realtimeCall(
      new NextRequest('http://localhost/api/realtime/call', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
        },
        body: 'v=0\r\n'
      })
    );
    expect(response.status).toBe(200);
    expect(createRealtimeCallAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        safetyIdentifier: expect.stringMatching(/^[0-9a-f]{32}$/)
      })
    );
  });
});

describe('authentication at paid route boundaries', () => {
  const credentials = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

  it.each([
    ['transcribe', transcribe],
    ['realtime/call', realtimeCall]
  ] as const)('fails closed for incomplete configuration on %s', async (path, handler) => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', '');
    const request = new NextRequest(`http://localhost/api/${path}`, {
      method: 'POST',
      headers: { authorization: credentials('operator:test-password') }
    });
    const readForm = vi.spyOn(request, 'formData');
    const readText = vi.spyOn(request, 'text');

    expect((await handler(request)).status).toBe(503);
    expect(readForm).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(transcribeFile).not.toHaveBeenCalled();
    expect(createRealtimeCallAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ['transcribe', transcribe],
    ['realtime/call', realtimeCall]
  ] as const)('rejects an incorrect password before processing %s', async (path, handler) => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    const request = new NextRequest(`http://localhost/api/${path}`, {
      method: 'POST',
      headers: { authorization: credentials('operator:wrong') }
    });
    const readForm = vi.spyOn(request, 'formData');
    const readText = vi.spyOn(request, 'text');

    expect((await handler(request)).status).toBe(401);
    expect(readForm).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(transcribeFile).not.toHaveBeenCalled();
    expect(createRealtimeCallAnswer).not.toHaveBeenCalled();
  });

  it('does not charge rejected requests against the verified account rate limit', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '1');
    vi.mocked(createRealtimeCallAnswer).mockResolvedValue({ sdp: 'v=0\r\n', model: 'test-model' });
    const call = (credential: string) =>
      realtimeCall(
        new NextRequest('http://localhost/api/realtime/call', {
          method: 'POST',
          headers: { authorization: credentials(credential) },
          body: 'v=0\r\n'
        })
      );

    expect((await call('operator:wrong')).status).toBe(401);
    expect((await call('operator:test-password')).status).toBe(200);
    expect((await call('operator:test-password')).status).toBe(429);
    expect(createRealtimeCallAnswer).toHaveBeenCalledTimes(1);
  });

  it('passes the verified account identifier to the provider despite changing forwarded addresses', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('TRUST_PROXY', 'true');
    vi.stubEnv('SAFETY_IDENTIFIER_SALT', 'synthetic-salt');
    vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '10');
    vi.mocked(createRealtimeCallAnswer).mockResolvedValue({ sdp: 'v=0\r\n', model: 'test-model' });
    for (const address of ['198.51.100.7', '198.51.100.8']) {
      const response = await realtimeCall(
        new NextRequest('http://localhost/api/realtime/call', {
          method: 'POST',
          headers: {
            authorization: credentials('operator:test-password'),
            'x-forwarded-for': address,
            'x-authenticated-user': 'forged-user'
          },
          body: 'v=0\r\n'
        })
      );
      expect(response.status).toBe(200);
    }
    const expected = createHash('sha256')
      .update('synthetic-salt:basic:operator')
      .digest('hex')
      .slice(0, 32);
    expect(createRealtimeCallAnswer).toHaveBeenCalledTimes(2);
    for (const [payload] of vi.mocked(createRealtimeCallAnswer).mock.calls) {
      expect(payload.safetyIdentifier).toBe(expected);
    }
  });

  it('allows an unauthenticated realtime request when authentication is disabled', async () => {
    vi.stubEnv('BASIC_AUTH_USER', '');
    vi.stubEnv('BASIC_AUTH_PASSWORD', '');
    vi.mocked(createRealtimeCallAnswer).mockResolvedValue({ sdp: 'v=0\r\n', model: 'test-model' });
    const response = await realtimeCall(
      new NextRequest('http://localhost/api/realtime/call', {
        method: 'POST',
        body: 'v=0\r\n'
      })
    );
    expect(response.status).toBe(200);
    expect(createRealtimeCallAnswer).toHaveBeenCalledTimes(1);
  });
});
