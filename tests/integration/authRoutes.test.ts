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
  vi.mocked(transcribeFile).mockReset();
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
      vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
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
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
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

  it('forwards authenticated request cancellation to realtime processing', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    vi.mocked(createRealtimeCallAnswer).mockResolvedValue({ sdp: 'v=0\r\n', model: 'test-model' });
    const controller = new AbortController();
    const request = new NextRequest('http://localhost/api/realtime/call', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
      },
      body: 'v=0\r\n',
      signal: controller.signal
    });

    expect((await realtimeCall(request)).status).toBe(200);
    const input = vi.mocked(createRealtimeCallAnswer).mock.calls[0][0];
    expect(input.signal).toBe(request.signal);
    controller.abort();
    expect(input.signal?.aborted).toBe(true);
  });

  it('checks authentication before a pre-aborted transcription request', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    const controller = new AbortController();
    controller.abort();
    const request = new NextRequest('http://localhost/api/transcribe', {
      method: 'POST',
      signal: controller.signal
    });
    const readForm = vi.spyOn(request, 'formData');

    expect((await transcribe(request)).status).toBe(401);
    expect(readForm).not.toHaveBeenCalled();
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it('stops an authenticated pre-aborted upload before parsing or upstream work', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    const controller = new AbortController();
    controller.abort();
    const request = new NextRequest('http://localhost/api/transcribe', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
      },
      signal: controller.signal
    });
    const readForm = vi.spyOn(request, 'formData');

    const response = await transcribe(request);
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe('TIMEOUT');
    expect(readForm).not.toHaveBeenCalled();
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it('stops an upload cancelled while its form is being read', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    const controller = new AbortController();
    const request = new NextRequest('http://localhost/api/transcribe', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
      },
      signal: controller.signal
    });
    let finishForm!: (form: FormData) => void;
    vi.spyOn(request, 'formData').mockImplementation(
      () => new Promise((resolve) => (finishForm = resolve))
    );
    const form = new FormData();
    form.set('file', new File(['fake audio'], 'meeting.mp3', { type: 'audio/mpeg' }));

    const pending = transcribe(request);
    controller.abort();
    finishForm(form);
    expect((await pending).status).toBe(504);
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it('propagates authenticated upload cancellation through the real adapter to the mocked SDK', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    const actual = await vi.importActual<typeof import('@/src/server/fileTranscription')>(
      '@/src/server/fileTranscription'
    );
    const listenerRemoved = vi.fn();
    let upstreamStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => (upstreamStarted = resolve));
    const create = vi.fn((_body: unknown, options: { signal: AbortSignal }) => {
      upstreamStarted(options.signal);
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          options.signal.removeEventListener('abort', onAbort);
          listenerRemoved();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        options.signal.addEventListener('abort', onAbort);
      });
    });
    const client = { audio: { transcriptions: { create } } };
    vi.mocked(transcribeFile).mockImplementation((input) =>
      actual.transcribeFile(input, client as never)
    );
    const form = new FormData();
    form.set('file', new File(['fake audio'], 'meeting.mp3', { type: 'audio/mpeg' }));
    const controller = new AbortController();
    const request = new NextRequest('http://localhost/api/transcribe', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
      },
      body: form,
      signal: controller.signal
    });

    const pending = transcribe(request);
    const upstreamSignal = await started;
    expect(vi.mocked(transcribeFile).mock.calls[0][0].signal).toBe(request.signal);
    expect(create.mock.calls[0][1]).toEqual({ signal: request.signal });
    expect(upstreamSignal.aborted).toBe(false);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(504);
    expect(upstreamSignal.aborted).toBe(true);
    expect(listenerRemoved).toHaveBeenCalledOnce();
  });

  it('preserves the existing timeout response for authenticated uploads', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    vi.mocked(transcribeFile).mockRejectedValue(new Error('Request timed out.'));
    const form = new FormData();
    form.set('file', new File(['fake audio'], 'meeting.mp3', { type: 'audio/mpeg' }));
    const controller = new AbortController();
    const request = new NextRequest('http://localhost/api/transcribe', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
      },
      body: form,
      signal: controller.signal
    });

    const response = await transcribe(request);
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe('TIMEOUT');
    expect(vi.mocked(transcribeFile).mock.calls[0][0].signal).toBe(request.signal);
    expect(controller.signal.aborted).toBe(false);
  });

  it('keeps upstream error mapping and excludes upload content from logs', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    const providerMessage = 'synthetic-provider-private-message';
    const prompt = 'synthetic-private-prompt';
    const audio = 'synthetic-private-audio';
    const error = Object.assign(new Error(providerMessage), { status: 503 });
    vi.mocked(transcribeFile).mockRejectedValue(error);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const form = new FormData();
      form.set('file', new File([audio], 'meeting.mp3', { type: 'audio/mpeg' }));
      form.set('prompt', prompt);
      const response = await transcribe(
        new NextRequest('http://localhost/api/transcribe', {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
          },
          body: form
        })
      );
      expect(response.status).toBe(502);
      expect((await response.json()).error.code).toBe('UPSTREAM_ERROR');
      const logs = JSON.stringify([...errorLog.mock.calls, ...infoLog.mock.calls]);
      expect(logs).not.toContain(providerMessage);
      expect(logs).not.toContain(prompt);
      expect(logs).not.toContain(audio);
    } finally {
      errorLog.mockRestore();
      infoLog.mockRestore();
    }
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

  it.each(['', 'https://example.com/path'])(
    'rejects originless paid requests with invalid origin %j',
    async (origin) => {
      vi.stubEnv('BASIC_AUTH_USER', 'operator');
      vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
      vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', origin);
      for (const [path, handler] of [
        ['transcribe', transcribe],
        ['realtime/call', realtimeCall]
      ] as const) {
        const request = new NextRequest(`http://localhost/api/${path}`, {
          method: 'POST',
          headers: { authorization: credentials('operator:test-password') }
        });
        const readForm = vi.spyOn(request, 'formData');
        const readText = vi.spyOn(request, 'text');
        expect((await handler(request)).status).toBe(503);
        expect(readForm).not.toHaveBeenCalled();
        expect(readText).not.toHaveBeenCalled();
      }
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(createRealtimeCallAnswer).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['transcribe', transcribe],
    ['realtime/call', realtimeCall]
  ] as const)('rejects an incorrect password before processing %s', async (path, handler) => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
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
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
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
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
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
