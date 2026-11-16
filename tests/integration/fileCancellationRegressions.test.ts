// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/transcribe/route';
import { resetRateLimits } from '@/src/server/rateLimit';
import { createRealtimeCallAnswer } from '@/src/server/realtime';

const sdk = vi.hoisted(() => ({
  create: vi.fn<(body: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>(),
  construct: vi.fn<(options: { timeout: number; maxRetries: number }) => void>(),
  toFile: vi.fn<(buffer: Buffer, name: string, options: { type: string }) => Promise<unknown>>()
}));

vi.mock('openai', () => ({
  default: class SyntheticOpenAI {
    audio = { transcriptions: { create: sdk.create } };

    constructor(options: { timeout: number; maxRetries: number }) {
      sdk.construct(options);
    }
  },
  toFile: sdk.toFile
}));

type Deferred<Value> = { promise: Promise<Value>; resolve: (value: Value) => void };

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function uploadRequest({
  signal,
  authenticated = true,
  origin
}: { signal?: AbortSignal; authenticated?: boolean; origin?: string } = {}) {
  const body = new FormData();
  body.set('file', new File(['synthetic audio'], 'synthetic.mp3', { type: 'audio/mpeg' }));
  body.set('language', 'en');
  body.set('model', 'gpt-4o-mini-transcribe');
  const headers = new Headers();
  if (authenticated) {
    headers.set(
      'authorization',
      `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`
    );
  }
  if (origin) headers.set('origin', origin);
  return new NextRequest('http://localhost/api/transcribe', {
    method: 'POST',
    headers,
    body,
    signal
  });
}

beforeEach(() => {
  vi.stubEnv('BASIC_AUTH_USER', 'synthetic-user');
  vi.stubEnv('BASIC_AUTH_PASSWORD', 'synthetic-password');
  vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  vi.stubEnv('REQUEST_TIMEOUT_MS', '73');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Network is forbidden in this test')))
  );
  sdk.construct.mockClear();
  sdk.create.mockReset();
  sdk.toFile.mockReset();
  sdk.create.mockResolvedValue({ text: 'Synthetic response.' });
  sdk.toFile.mockResolvedValue({ name: 'synthetic.mp3' });
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRateLimits();
});

describe('authenticated upload cancellation through the mocked SDK', () => {
  it.each([
    ['missing credentials', { authenticated: false }, 401],
    ['foreign origin', { origin: 'https://foreign.example' }, 403]
  ] as const)(
    'rejects %s before reading the form or creating upstream work',
    async (_label, init, status) => {
      const request = uploadRequest(init);
      const formData = vi.spyOn(request, 'formData');
      const result = await POST(request);
      expect(result.status).toBe(status);
      expect(formData).not.toHaveBeenCalled();
      expect(sdk.construct).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
    }
  );

  it('keeps a normal authenticated text-only response and the configured SDK timeout', async () => {
    const result = await POST(uploadRequest());
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.transcript.text).toBe('Synthetic response.');
    expect(body.transcript.segments ?? []).toEqual([]);
    expect(sdk.construct).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 73, maxRetries: 1 })
    );
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-4o-mini-transcribe',
      language: 'en',
      response_format: 'json'
    });
  });

  it('does not start SDK transcription for an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await POST(uploadRequest({ signal: controller.signal }));
    expect(sdk.create).not.toHaveBeenCalled();
    expect(result.status).not.toBe(200);
  });

  it('aborts the in-flight SDK request when the browser request is cancelled', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let upstreamSignal: AbortSignal | undefined;
    let releaseUncancelled!: () => void;
    sdk.create.mockImplementation((_body, options) => {
      upstreamSignal = options?.signal;
      started.resolve();
      return new Promise((resolve, reject) => {
        releaseUncancelled = () => resolve({ text: 'should not be accepted' });
        const abort = () => reject(new DOMException('synthetic cancellation', 'AbortError'));
        if (upstreamSignal?.aborted) abort();
        else upstreamSignal?.addEventListener('abort', abort, { once: true });
      });
    });
    const resultPromise = POST(uploadRequest({ signal: controller.signal }));
    await started.promise;
    controller.abort();
    const aborted = upstreamSignal?.aborted;
    if (!aborted) releaseUncancelled();
    const result = await resultPromise;
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
    expect(aborted).toBe(true);
    expect(result.status).not.toBe(200);
  });

  it('retains SDK timeout failure behavior when a request signal is supplied', async () => {
    const controller = new AbortController();
    sdk.create.mockRejectedValue(new Error('synthetic SDK timeout'));
    const result = await POST(uploadRequest({ signal: controller.signal }));
    expect(sdk.construct).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 73, maxRetries: 1 })
    );
    expect(controller.signal.aborted).toBe(false);
    expect(result.status).toBe(504);
    expect(await result.json()).toMatchObject({ error: { code: 'TIMEOUT', retryable: true } });
  });
});

describe('defensive provider response boundary', () => {
  it.each([
    ['null', null],
    ['non-array', { start: 1, end: 2, text: 'Synthetic response.' }]
  ] as const)('omits a %s segment list while retaining text', async (_label, segments) => {
    sdk.create.mockResolvedValue({ text: 'Synthetic response.', segments });
    const result = await POST(uploadRequest());
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.transcript.text).toBe('Synthetic response.');
    expect(body.transcript.segments ?? []).toEqual([]);
  });

  it.each([
    ['null item', null],
    ['missing times', { text: 'second' }],
    ['null times', { start: null, end: null, text: 'second' }],
    ['negative time', { start: -1, end: 3, text: 'second' }],
    ['reversed times', { start: 3, end: 2, text: 'second' }],
    ['non-finite time', { start: Number.NaN, end: 3, text: 'second' }],
    ['missing text', { start: 2, end: 3 }]
  ] as const)('drops all alignment for a mixed response with %s', async (_label, invalid) => {
    sdk.create.mockResolvedValue({
      text: 'first second',
      segments: [{ start: 1, end: 2, text: 'first' }, invalid]
    });
    const result = await POST(uploadRequest());
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.transcript.text).toBe('first second');
    expect(body.transcript.segments ?? []).toEqual([]);
  });
});

describe('explicit-turn session contract', () => {
  it('keeps turn detection disabled and the configured realtime model in the synthetic request', async () => {
    vi.stubEnv('OPENAI_REALTIME_STT_MODEL', 'gpt-realtime-whisper');
    let session: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as FormData;
        session = JSON.parse(String(body.get('session')));
        return new Response('v=0\r\n');
      })
    );
    await expect(
      createRealtimeCallAnswer({ sdp: 'v=0\r\n', language: 'en', delay: 'low' })
    ).resolves.toMatchObject({ model: 'gpt-realtime-whisper' });
    expect(session).toMatchObject({
      type: 'transcription',
      audio: {
        input: {
          turn_detection: null,
          transcription: { model: 'gpt-realtime-whisper' }
        }
      }
    });
  });
});
