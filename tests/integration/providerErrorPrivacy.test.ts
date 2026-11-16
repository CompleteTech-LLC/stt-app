// @vitest-environment node

import { inspect } from 'node:util';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as transcribe } from '@/app/api/transcribe/route';
import { POST as realtimeCall } from '@/app/api/realtime/call/route';
import { getServerConfig } from '@/src/lib/config';
import { appLimits, sttModels } from '@/src/lib/constants';
import { logger } from '@/src/lib/logging';
import { resetRateLimits } from '@/src/server/rateLimit';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  construct: vi.fn()
}));

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  return {
    ...actual,
    default: class {
      audio = { transcriptions: { create: sdk.create } };

      constructor(options: unknown) {
        sdk.construct(options);
      }
    }
  };
});

const privatePrefix = 'SYNTHETIC_PRIVATE_PROVIDER_';
const authUser = 'fixture-user';
const authPassword = 'fixture-password';
const fakeApiKey = 'synthetic-only-test-key';
const origin = 'http://localhost';
const authorization = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`;
const offer = 'v=0\r\ns=synthetic-offer\r\n';
const logMethods = ['info', 'warn', 'error'] as const;
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

const upstreamFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
  () => Promise.reject(new Error('Unexpected synthetic transport call.'))
);

type RequestOptions = {
  authorized?: boolean;
  requestOrigin?: string;
  invalidFile?: boolean;
  query?: string;
  signal?: AbortSignal;
};

type ApiError = {
  code: string;
  message: string;
  retryable: boolean;
  upstreamStatus?: unknown;
};

const requestHeaders = ({ authorized = true, requestOrigin = origin }: RequestOptions) => ({
  ...(authorized ? { authorization } : {}),
  origin: requestOrigin
});

function uploadRequest(options: RequestOptions = {}) {
  const form = new FormData();
  form.set(
    'file',
    options.invalidFile
      ? new File(['synthetic bytes'], 'fixture.bin', { type: 'application/octet-stream' })
      : new File(['synthetic audio'], 'fixture.mp3', { type: 'audio/mpeg' })
  );
  return new NextRequest(`${origin}/api/transcribe`, {
    method: 'POST',
    headers: requestHeaders(options),
    body: form,
    signal: options.signal
  });
}

function realtimeRequest(options: RequestOptions = {}) {
  return new NextRequest(`${origin}/api/realtime/call${options.query ?? ''}`, {
    method: 'POST',
    headers: requestHeaders(options),
    body: offer,
    signal: options.signal
  });
}

function clearObservedLogs() {
  for (const method of logMethods) vi.mocked(logger[method]).mockClear();
  for (const method of consoleMethods) vi.mocked(console[method]).mockClear();
}

function expectNoPrivateLogs() {
  const observed = {
    logger: logMethods.map((method) => vi.mocked(logger[method]).mock.calls),
    console: consoleMethods.map((method) => vi.mocked(console[method]).mock.calls)
  };
  expect(
    inspect(observed, {
      depth: null,
      showHidden: true,
      maxArrayLength: null,
      maxStringLength: null
    })
  ).not.toContain(privatePrefix);
}

async function readError(response: Response, checkPrivacy = true): Promise<ApiError> {
  const body = await response.text();
  if (checkPrivacy) expect(body).not.toContain(privatePrefix);
  const parsed = JSON.parse(body) as { error: ApiError };
  expect(typeof parsed.error.message).toBe('string');
  expect(parsed.error.message.trim()).not.toBe('');
  return parsed.error;
}

function expectValidUpstreamStatus(status: unknown) {
  if (status === undefined) return;
  expect(typeof status).toBe('number');
  if (typeof status === 'number') {
    expect(Number.isInteger(status)).toBe(true);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThanOrEqual(599);
  }
}

const shapes = [
  'top-message',
  'top-code',
  'top-type',
  'nested-message',
  'nested-code',
  'nested-type',
  'mixed'
] as const;
type Shape = (typeof shapes)[number];

const marker = (field: string) => `${privatePrefix}${field.replaceAll('-', '_').toUpperCase()}`;

function sdkError(status: unknown, shape: Shape) {
  if (shape === 'mixed') {
    return Object.assign(new Error(marker('top-message')), {
      status,
      code: marker('top-code'),
      error: { message: marker('nested-message'), code: marker('nested-code') }
    });
  }
  const [location, field] = shape.split('-');
  const error = Object.assign(
    new Error(location === 'top' && field === 'message' ? marker(shape) : 'Synthetic SDK wrapper.'),
    { status }
  );
  if (location === 'nested') Object.assign(error, { error: { [field]: marker(shape) } });
  else if (field !== 'message') Object.assign(error, { [field]: marker(shape) });
  return error;
}

function httpError(shape: Shape) {
  if (shape === 'mixed') {
    return {
      message: marker('top-message'),
      code: marker('top-code'),
      error: { message: marker('nested-message'), code: marker('nested-code') }
    };
  }
  const [location, field] = shape.split('-');
  return location === 'nested' ? { error: { [field]: marker(shape) } } : { [field]: marker(shape) };
}

const statusCases = [
  { upstream: 401, client: 503, retryable: false },
  { upstream: 403, client: 502, retryable: false },
  { upstream: 429, client: 502, retryable: false },
  { upstream: 503, client: 502, retryable: true }
] as const;

beforeEach(() => {
  vi.stubEnv('BASIC_AUTH_USER', authUser);
  vi.stubEnv('BASIC_AUTH_PASSWORD', authPassword);
  vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', origin);
  vi.stubEnv('OPENAI_API_KEY', fakeApiKey);
  vi.stubEnv('OPENAI_REALTIME_STT_MODEL', '');
  vi.stubEnv('OPENAI_FILE_STT_MODEL', '');
  vi.stubEnv('OPENAI_HIGH_ACCURACY_FILE_STT_MODEL', '');
  vi.stubEnv('MAX_UPLOAD_BYTES', String(appLimits.maxUploadBytes));
  vi.stubEnv('REQUEST_TIMEOUT_MS', String(appLimits.requestTimeoutMs));
  vi.stubEnv('REALTIME_SESSION_TIMEOUT_MS', String(appLimits.realtimeSessionTimeoutMs));
  vi.stubEnv('RATE_LIMIT_WINDOW_MS', String(appLimits.rateLimitWindowMs));
  vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', String(appLimits.rateLimitMaxRequests));
  vi.stubEnv('LOG_TRANSCRIPTS', 'false');
  vi.stubEnv('TRUST_PROXY', 'false');
  vi.stubEnv('SAFETY_IDENTIFIER_SALT', 'synthetic-only-salt');
  resetRateLimits();
  sdk.create.mockReset().mockRejectedValue(new Error('Unexpected synthetic SDK call.'));
  sdk.construct.mockReset();
  upstreamFetch.mockReset().mockRejectedValue(new Error('Unexpected synthetic transport call.'));
  vi.stubGlobal('fetch', upstreamFetch);
  for (const method of consoleMethods) vi.spyOn(console, method).mockImplementation(() => {});
  for (const method of logMethods) vi.spyOn(logger, method);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRateLimits();
  sdk.create.mockReset();
  sdk.construct.mockReset();
  upstreamFetch.mockReset();
});

describe('authenticated provider error privacy', () => {
  describe.each(['client', 'logs'] as const)('%s exposure', (target) => {
    it.each(statusCases)(
      'sanitizes SDK upload fields for upstream HTTP $upstream',
      async ({ upstream, client, retryable }) => {
        const messages: string[] = [];
        for (const shape of shapes) {
          resetRateLimits();
          clearObservedLogs();
          sdk.create.mockReset().mockRejectedValue(sdkError(upstream, shape));

          const response = await transcribe(uploadRequest());
          expect(response.status, shape).toBe(client);
          const error = await readError(response, target === 'client');
          expect(error, shape).toMatchObject({
            code: 'UPSTREAM_ERROR',
            retryable,
            upstreamStatus: upstream
          });
          if (upstream === 401) expect(error.message).toBe('OpenAI rejected the server API key.');
          messages.push(error.message);
          expect(sdk.create, shape).toHaveBeenCalledTimes(1);
          expect(upstreamFetch, shape).not.toHaveBeenCalled();
          expect(logger.error, shape).toHaveBeenCalledWith(
            'transcription_failed',
            expect.objectContaining({ code: 'UPSTREAM_ERROR', status: client, retryable })
          );
          if (target === 'logs') expectNoPrivateLogs();
        }
        if (target === 'client') expect(new Set(messages).size).toBe(1);
      }
    );

    it.each(statusCases)(
      'sanitizes realtime HTTP fields for upstream HTTP $upstream',
      async ({ upstream, client, retryable }) => {
        const messages: string[] = [];
        for (const shape of shapes) {
          resetRateLimits();
          clearObservedLogs();
          upstreamFetch.mockReset().mockResolvedValue(
            new Response(JSON.stringify(httpError(shape)), {
              status: upstream,
              headers: { 'content-type': 'application/json' }
            })
          );

          const response = await realtimeCall(realtimeRequest());
          expect(response.status, shape).toBe(client);
          const error = await readError(response, target === 'client');
          expect(error, shape).toMatchObject({
            code: 'UPSTREAM_ERROR',
            retryable,
            upstreamStatus: upstream
          });
          if (upstream === 401) expect(error.message).toBe('OpenAI rejected the server API key.');
          messages.push(error.message);
          expect(upstreamFetch, shape).toHaveBeenCalledTimes(1);
          expect(sdk.construct, shape).not.toHaveBeenCalled();
          expect(logger.error, shape).toHaveBeenCalledWith(
            'realtime_call_failed',
            expect.objectContaining({ code: 'UPSTREAM_ERROR', status: client, retryable })
          );
          if (target === 'logs') expectNoPrivateLogs();
        }
        if (target === 'client') expect(new Set(messages).size).toBe(1);
      }
    );
  });

  it('keeps upstream 401 ahead of timeout-like SDK messages', async () => {
    sdk.create.mockRejectedValue(
      Object.assign(new Error(`${marker('top-message')} timed out`), {
        status: 401,
        error: { message: marker('nested-message'), code: marker('nested-code') }
      })
    );
    const response = await transcribe(uploadRequest());
    expect(response.status).toBe(503);
    expect(await readError(response)).toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'OpenAI rejected the server API key.',
      retryable: false,
      upstreamStatus: 401
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    expectNoPrivateLogs();
  });

  it.each([
    ['numeric string', '503'],
    ['fraction', 503.5],
    ['out of HTTP range', 600],
    ['infinity', Infinity]
  ])('does not publish an invalid SDK upstream status: %s', async (_label, status) => {
    sdk.create.mockRejectedValue(sdkError(status, 'mixed'));
    const response = await transcribe(uploadRequest());
    const error = await readError(response, false);
    expectValidUpstreamStatus(error.upstreamStatus);
    expect(logger.error).toHaveBeenCalled();
    for (const [, metadata] of vi.mocked(logger.error).mock.calls) {
      expectValidUpstreamStatus(metadata?.upstreamStatus);
    }
    expectNoPrivateLogs();
  });
});

describe('route controls', () => {
  const routes = [
    { name: 'upload', handler: transcribe, request: uploadRequest },
    { name: 'realtime', handler: realtimeCall, request: realtimeRequest }
  ] as const;

  it.each(routes)(
    '$name denies unauthenticated requests before body or upstream',
    async (route) => {
      const request = route.request({ authorized: false });
      const readForm = vi.spyOn(request, 'formData');
      const readText = vi.spyOn(request, 'text');
      expect((await route.handler(request)).status).toBe(401);
      expect(readForm).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(request.bodyUsed).toBe(false);
      expect(request.body?.locked).toBe(false);
      expect(sdk.construct).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
      expect(upstreamFetch).not.toHaveBeenCalled();
    }
  );

  it.each(routes)('$name denies cross-site requests before body or upstream', async (route) => {
    const request = route.request({ requestOrigin: 'https://foreign.example' });
    const readForm = vi.spyOn(request, 'formData');
    const readText = vi.spyOn(request, 'text');
    expect((await route.handler(request)).status).toBe(403);
    expect(readForm).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(request.body?.locked).toBe(false);
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('preserves a trusted upload validation AppError message', async () => {
    const response = await transcribe(uploadRequest({ invalidFile: true }));
    expect(response.status).toBe(415);
    expect(await readError(response)).toMatchObject({
      code: 'INVALID_FILE',
      message: 'Unsupported file type. Upload a common audio or video file.',
      retryable: false
    });
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
    expectNoPrivateLogs();
  });

  it('preserves a trusted realtime validation message', async () => {
    const response = await realtimeCall(realtimeRequest({ query: '?language=not%20valid' }));
    expect(response.status).toBe(400);
    expect(await readError(response)).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Use a valid language hint.',
      retryable: false
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(sdk.construct).not.toHaveBeenCalled();
    expectNoPrivateLogs();
  });

  it('returns an authenticated upload success with existing SDK options', async () => {
    sdk.create.mockResolvedValue({ text: 'Synthetic transcript.' });
    const request = uploadRequest();
    const response = await transcribe(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      transcript: {
        text: 'Synthetic transcript.',
        language: 'en',
        model: sttModels.fileDefault,
        segments: []
      }
    });
    expect(sdk.construct).toHaveBeenCalledWith({
      apiKey: fakeApiKey,
      timeout: getServerConfig().limits.requestTimeoutMs,
      maxRetries: 1
    });
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ name: 'fixture.mp3', type: 'audio/mpeg' }),
        model: sttModels.fileDefault,
        language: 'en',
        prompt: undefined,
        response_format: 'json'
      }),
      { signal: request.signal }
    );
    expect(upstreamFetch).not.toHaveBeenCalled();
    expectNoPrivateLogs();
  });

  it('returns an authenticated realtime SDP answer with existing session options', async () => {
    const answer = 'v=0\r\ns=synthetic-answer\r\n';
    upstreamFetch.mockResolvedValue(new Response(answer, { status: 200 }));
    const response = await realtimeCall(realtimeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/sdp');
    expect(await response.text()).toBe(answer);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, options] = upstreamFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'OpenAI-Safety-Identifier': expect.stringMatching(/^[0-9a-f]{32}$/) }
    });
    const form = options?.body as FormData;
    expect(form.get('sdp')).toBe(offer);
    expect(JSON.parse(String(form.get('session')))).toMatchObject({
      type: 'transcription',
      audio: {
        input: {
          transcription: { model: getServerConfig().models.realtime, language: 'en', delay: 'low' },
          turn_detection: null
        }
      }
    });
    expect(sdk.construct).not.toHaveBeenCalled();
    expectNoPrivateLogs();
  });

  it('maps a synthetic SDK timeout to retryable 504 without logging its message', async () => {
    sdk.create.mockRejectedValue(
      Object.assign(new Error(marker('upload-delay')), { name: 'APIConnectionTimeoutError' })
    );
    const response = await transcribe(uploadRequest());
    expect(response.status).toBe(504);
    expect(await readError(response)).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    expectNoPrivateLogs();
  });

  it('propagates upload cancellation and maps it to retryable 504', async () => {
    const controller = new AbortController();
    let announce!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => (announce = resolve));
    sdk.create.mockImplementation((_body: unknown, options: { signal: AbortSignal }) => {
      const signal = options.signal;
      announce(signal);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });
    const pending = transcribe(uploadRequest({ signal: controller.signal }));
    const signal = await Promise.race([
      started,
      pending.then(() => {
        throw new Error('Upload ended before reaching the synthetic SDK.');
      })
    ]);
    controller.abort(new DOMException(marker('upload-cancel'), 'AbortError'));
    const response = await pending;
    expect(signal.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(await readError(response)).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(logger.error).toHaveBeenCalled();
    expectNoPrivateLogs();
  });

  it.each(['timeout', 'client cancellation'] as const)(
    'maps realtime %s to retryable 504',
    async (mode) => {
      vi.useFakeTimers();
      vi.stubEnv('REALTIME_SESSION_TIMEOUT_MS', '25');
      const controller = new AbortController();
      let announce!: (signal: AbortSignal) => void;
      const started = new Promise<AbortSignal>((resolve) => (announce = resolve));
      upstreamFetch.mockImplementation((_input, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error('Synthetic transport requires an abort signal.');
        announce(signal);
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      });

      const pending = realtimeCall(realtimeRequest({ signal: controller.signal }));
      const signal = await Promise.race([
        started,
        pending.then(() => {
          throw new Error('Realtime ended before reaching the synthetic transport.');
        })
      ]);
      if (mode === 'timeout') {
        await vi.advanceTimersByTimeAsync(25);
        expect(controller.signal.aborted).toBe(false);
      } else {
        controller.abort(new DOMException(marker('realtime-cancel'), 'AbortError'));
      }
      const response = await pending;
      expect(signal.aborted).toBe(true);
      expect(response.status).toBe(504);
      expect(await readError(response)).toMatchObject({ code: 'TIMEOUT', retryable: true });
      expect(logger.error).toHaveBeenCalled();
      expectNoPrivateLogs();
    }
  );
});
