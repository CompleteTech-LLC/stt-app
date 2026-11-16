// @vitest-environment node

import { inspect } from 'node:util';

import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/transcribe/route';
import { logger } from '@/src/lib/logging';
import { resetRateLimits } from '@/src/server/rateLimit';

const clientFactory = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/src/server/openaiClient', () => ({
  createOpenAIClient: clientFactory.create
}));

const privateMarker = 'SYNTHETIC_PRIVATE_CANCELLATION_DETAIL';
const authorization = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
const logMethods = ['info', 'warn', 'error'] as const;
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const reasons = [
  { label: 'ordinary Error', make: () => new Error(privateMarker) },
  { label: 'string', make: () => `${privateMarker}_STRING` },
  { label: 'non-Error object', make: () => ({ detail: privateMarker }) },
  { label: 'default AbortError', make: () => undefined }
] as const;

function uploadRequest(signal: AbortSignal, authenticated = true) {
  const form = new FormData();
  form.set('file', new File(['synthetic audio'], 'fixture.mp3', { type: 'audio/mpeg' }));
  form.set('model', 'gpt-4o-mini-transcribe');
  form.set('language', 'en');
  return new NextRequest('http://localhost/api/transcribe', {
    method: 'POST',
    headers: { ...(authenticated ? { authorization } : {}), origin: 'http://localhost' },
    body: form,
    signal
  });
}

function abortWith(controller: AbortController, reason: unknown) {
  if (reason === undefined) controller.abort();
  else controller.abort(reason);
}

function installSdk(transport: typeof fetch, timeout = 1000) {
  clientFactory.create.mockReturnValue(
    new OpenAI({ apiKey: 'synthetic-test-key', timeout, maxRetries: 0, fetch: transport })
  );
}

async function bounded<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function expectNoPrivateDiagnostics(body: string) {
  expect(body).not.toContain(privateMarker);
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
  ).not.toContain(privateMarker);
}

async function expectCancellation(response: Response) {
  const body = await response.text();
  expect(response.status).toBe(504);
  expect(JSON.parse(body)).toMatchObject({ error: { code: 'TIMEOUT', retryable: true } });
  expect(logger.error).toHaveBeenCalledWith(
    'transcription_failed',
    expect.objectContaining({ code: 'TIMEOUT', status: 504, retryable: true })
  );
  expectNoPrivateDiagnostics(body);
}

beforeEach(() => {
  vi.stubEnv('BASIC_AUTH_USER', 'fixture-user');
  vi.stubEnv('BASIC_AUTH_PASSWORD', 'fixture-password');
  vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  vi.stubEnv('LOG_TRANSCRIPTS', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network access')))
  );
  clientFactory.create.mockReset();
  resetRateLimits();
  for (const method of consoleMethods) vi.spyOn(console, method).mockImplementation(() => {});
  for (const method of logMethods) vi.spyOn(logger, method);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRateLimits();
});

describe('authenticated upload cancellation with real SDK transport', () => {
  it('authenticates before reading even an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error(privateMarker));
    const request = uploadRequest(controller.signal, false);
    const readBody = vi.spyOn(request, 'formData');
    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(clientFactory.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expectNoPrivateDiagnostics(await response.text());
  });

  it.each(reasons)(
    'maps a pre-aborted $label without reading the body or starting the SDK',
    async ({ make }) => {
      const controller = new AbortController();
      abortWith(controller, make());
      const request = uploadRequest(controller.signal);
      const readBody = vi.spyOn(request, 'formData');
      const response = await POST(request);

      expect(request.signal.aborted).toBe(true);
      expect(readBody).not.toHaveBeenCalled();
      expect(clientFactory.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      await expectCancellation(response);
    }
  );

  it.each(reasons)(
    'maps an in-flight $label after the real SDK aborts its synthetic transport',
    async ({ make }) => {
      let markStarted!: (signal: AbortSignal) => void;
      let releaseTransport: (() => void) | undefined;
      const started = new Promise<AbortSignal>((resolve) => {
        markStarted = resolve;
      });
      const transport = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (!signal) throw new Error('SDK transport did not supply a signal');
        markStarted(signal);
        return new Promise<Response>((_resolve, reject) => {
          releaseTransport = () => reject(new Error('Synthetic transport released during cleanup'));
          const abort = () => reject(new DOMException(`${privateMarker} transport`, 'AbortError'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      });
      installSdk(transport as typeof fetch, 3000);
      const controller = new AbortController();
      const request = uploadRequest(controller.signal);
      const result = POST(request);
      try {
        const upstreamSignal = await bounded(
          Promise.race([
            started,
            result.then((response) => {
              throw new Error(`Route returned ${response.status} before SDK transport started`);
            })
          ]),
          'SDK transport'
        );
        expect(upstreamSignal.aborted).toBe(false);
        abortWith(controller, make());
        expect(request.signal.aborted).toBe(true);
        const response = await bounded(result, 'cancelled route response');
        expect(upstreamSignal.aborted).toBe(true);
        expect(clientFactory.create).toHaveBeenCalledTimes(1);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
        await expectCancellation(response);
      } finally {
        if (!controller.signal.aborted) controller.abort();
        releaseTransport?.();
      }
    },
    6000
  );

  it('does not classify a non-cancelled upstream failure as cancellation', async () => {
    const controller = new AbortController();
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: privateMarker, code: privateMarker } }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
    );
    installSdk(transport as typeof fetch);
    const response = await bounded(POST(uploadRequest(controller.signal)), 'upstream response');
    const body = await response.text();

    expect(controller.signal.aborted).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({
      error: { code: 'UPSTREAM_ERROR', retryable: true, upstreamStatus: 503 }
    });
    expectNoPrivateDiagnostics(body);
  });

  it('retains a normal non-cancelled text-only SDK response', async () => {
    const controller = new AbortController();
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: 'synthetic transcript' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    installSdk(transport as typeof fetch);
    const response = await bounded(POST(uploadRequest(controller.signal)), 'successful response');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      transcript: { text: 'synthetic transcript', segments: [] }
    });
    expect(controller.signal.aborted).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expectNoPrivateDiagnostics(body);
  });
});
