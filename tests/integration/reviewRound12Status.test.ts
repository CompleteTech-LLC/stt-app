// @vitest-environment node

import { inspect } from 'node:util';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as realtimeCall } from '@/app/api/realtime/call/route';
import { appLimits, sttModels } from '@/src/lib/constants';
import { logger } from '@/src/lib/logging';
import { resetRateLimits } from '@/src/server/rateLimit';
import { createRealtimeCallAnswer } from '@/src/server/realtime';

const origin = 'http://localhost';
const upstreamUrl = 'https://api.openai.com/v1/realtime/calls';
const offer = 'v=0\r\ns=synthetic offer\r\n';
const answer = 'v=0\r\ns=synthetic answer\r\n';
const apiKey = 'synthetic-test-key';
const authUser = 'fixture-user';
const authPassword = 'fixture-password';
const authorization = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString('base64')}`;
const privateMarker = 'SYNTHETIC_PRIVATE_PROVIDER_ROUND12';
const logMethods = ['info', 'warn', 'error'] as const;
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

type ErrorBody = {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    upstreamStatus?: unknown;
    upstreamCode?: unknown;
  };
};

type TransportPlan = (signal: AbortSignal) => Promise<Response>;
type StreamMode = 'erroring' | 'stalled';

let transportPlan: TransportPlan | null;
let requests: { url: string; init: RequestInit }[];
let unexpected: string[];

const upstreamFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (
    url !== upstreamUrl ||
    init?.method !== 'POST' ||
    !(init.body instanceof FormData) ||
    !(init.signal instanceof AbortSignal) ||
    !transportPlan
  ) {
    unexpected.push(`Unexpected synthetic transport: ${init?.method || 'GET'} ${url}`);
    return Promise.reject(new Error('Unexpected synthetic transport'));
  }
  requests.push({ url, init });
  const plan = transportPlan;
  transportPlan = null;
  return plan(init.signal);
});

function request(options: { authenticated?: boolean; signal?: AbortSignal } = {}) {
  return new NextRequest(`${origin}/api/realtime/call?language=en&delay=low`, {
    method: 'POST',
    headers: {
      ...(options.authenticated === false ? {} : { authorization }),
      origin,
      'Content-Type': 'application/sdp'
    },
    body: offer,
    signal: options.signal
  });
}

async function bounded<Value>(promise: Promise<Value>, description: string, delay = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = nativeSetTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          delay
        );
      })
    ]);
  } finally {
    if (timer !== undefined) nativeClearTimeout(timer);
  }
}

async function settle(operation: Promise<unknown>) {
  await bounded(
    operation.then(
      () => undefined,
      () => undefined
    ),
    'owned operation cleanup'
  );
}

function responseWithBody(status: number, mode: StreamMode) {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (mode === 'erroring') {
        controller.error(new TypeError(`${privateMarker}_BODY_STREAM_FAILURE`));
      } else {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ error: { message: `${privateMarker}_MESSAGE`, code: privateMarker } })
          )
        );
      }
    }
  });
  return {
    response: new Response(stream, { status, headers: { 'Content-Type': 'application/json' } }),
    release: () => {
      try {
        streamController?.close();
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
  };
}

function expectNoPrivateData(responseText: string) {
  const observed = {
    responseText,
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

function expectTransportRequest(index = 0) {
  const sent = requests[index];
  expect(sent.url).toBe(upstreamUrl);
  const headers = new Headers(sent.init.headers);
  expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
  const form = sent.init.body as FormData;
  expect(form.get('sdp')).toBe(offer);
  const session = JSON.parse(String(form.get('session')));
  expect(session.type).toBe('transcription');
  expect(session.audio.input.turn_detection).toBeNull();
  expect(session.audio.input.transcription).toMatchObject({
    model: sttModels.realtime,
    language: 'en',
    delay: 'low'
  });
}

async function callWithStream(status: number, mode: StreamMode) {
  const fixture = responseWithBody(status, mode);
  const controller = new AbortController();
  transportPlan = async () => fixture.response;
  const operation = realtimeCall(request({ signal: controller.signal }));
  try {
    const response = await bounded(operation, `${mode} HTTP ${status} without body or abort`);
    expect(controller.signal.aborted).toBe(false);
    return response;
  } finally {
    fixture.release();
    controller.abort();
    await settle(operation);
  }
}

async function callWithReadableResponse(response: Response, description: string) {
  const controller = new AbortController();
  transportPlan = async () => response;
  const operation = realtimeCall(request({ signal: controller.signal }));
  try {
    return await bounded(operation, description);
  } finally {
    controller.abort();
    await settle(operation);
  }
}

function holdUntilAbort(onStart: (signal: AbortSignal) => void): TransportPlan {
  return (signal) => {
    onStart(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

beforeEach(() => {
  transportPlan = null;
  requests = [];
  unexpected = [];
  upstreamFetch.mockClear();
  vi.stubEnv('BASIC_AUTH_USER', authUser);
  vi.stubEnv('BASIC_AUTH_PASSWORD', authPassword);
  vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', origin);
  vi.stubEnv('OPENAI_API_KEY', apiKey);
  vi.stubEnv('OPENAI_REALTIME_STT_MODEL', '');
  vi.stubEnv('OPENAI_FILE_STT_MODEL', '');
  vi.stubEnv('OPENAI_HIGH_ACCURACY_FILE_STT_MODEL', '');
  vi.stubEnv('REALTIME_SESSION_TIMEOUT_MS', String(appLimits.realtimeSessionTimeoutMs));
  vi.stubEnv('RATE_LIMIT_WINDOW_MS', String(appLimits.rateLimitWindowMs));
  vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', String(appLimits.rateLimitMaxRequests));
  vi.stubEnv('TRUST_PROXY', 'false');
  vi.stubEnv('LOG_TRANSCRIPTS', 'false');
  vi.stubEnv('SAFETY_IDENTIFIER_SALT', 'synthetic-only-salt');
  vi.stubGlobal('fetch', upstreamFetch);
  for (const method of consoleMethods) vi.spyOn(console, method).mockImplementation(() => {});
  for (const method of logMethods) vi.spyOn(logger, method);
  resetRateLimits();
});

afterEach(() => {
  try {
    expect(unexpected).toEqual([]);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRateLimits();
  }
});

const statuses = [
  { upstream: 401, client: 503, retryable: false },
  { upstream: 403, client: 502, retryable: false },
  { upstream: 429, client: 502, retryable: false },
  { upstream: 503, client: 502, retryable: true }
] as const;

describe('round 12 authenticated realtime status and privacy', () => {
  describe.each(statuses)('upstream HTTP $upstream', ({ upstream, client, retryable }) => {
    it.each(['erroring', 'stalled'] as const)(
      'maps the known status without reading an %s body',
      async (mode) => {
        const response = await callWithStream(upstream, mode);
        expect(response.status).toBe(client);
        const responseText = await response.text();
        const parsed = JSON.parse(responseText) as ErrorBody;
        expect(parsed.error).toMatchObject({
          code: 'UPSTREAM_ERROR',
          retryable,
          upstreamStatus: upstream
        });
        expect(typeof parsed.error.upstreamStatus).toBe('number');
        expect(Number.isInteger(parsed.error.upstreamStatus)).toBe(true);
        expect(parsed.error.upstreamCode).toBeUndefined();
        expect(parsed.error.message.trim()).not.toBe('');
        if (upstream === 401) {
          expect(parsed.error.message).toBe('OpenAI rejected the server API key.');
        } else {
          expect(parsed.error.message).toContain(`HTTP ${upstream}`);
        }
        expectTransportRequest();
        expect(logger.error).toHaveBeenCalledWith(
          'realtime_call_failed',
          expect.objectContaining({
            code: 'UPSTREAM_ERROR',
            status: client,
            retryable,
            upstreamStatus: upstream,
            upstreamCode: undefined
          })
        );

        const readable = await callWithReadableResponse(
          new Response(
            JSON.stringify({ error: { message: `${privateMarker}_OTHER`, type: privateMarker } }),
            { status: upstream }
          ),
          'readable error control'
        );
        expect(readable.status).toBe(client);
        const readableText = await readable.text();
        const readableError = (JSON.parse(readableText) as ErrorBody).error;
        expect(readableError.message).toBe(parsed.error.message);
        expect(readableError).toMatchObject({
          code: 'UPSTREAM_ERROR',
          retryable,
          upstreamStatus: upstream
        });
        expect(upstreamFetch).toHaveBeenCalledTimes(2);
        expectNoPrivateData(responseText + readableText);
      }
    );
  });

  it.each([
    { upstream: 401, mode: 'stalled', client: 503, retryable: false },
    { upstream: 503, mode: 'erroring', client: 502, retryable: true }
  ] as const)(
    'maps HTTP $upstream directly in the real adapter with an $mode body',
    async ({ upstream, mode, client, retryable }) => {
      const fixture = responseWithBody(upstream, mode);
      const controller = new AbortController();
      transportPlan = async () => fixture.response;
      const operation = createRealtimeCallAnswer({
        sdp: offer,
        language: 'en',
        delay: 'low',
        signal: controller.signal
      });
      try {
        const outcome = await bounded(
          operation.then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error })
          ),
          `adapter HTTP ${upstream} without body or abort`
        );
        expect(controller.signal.aborted).toBe(false);
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
          expect(outcome.error).toMatchObject({
            code: 'UPSTREAM_ERROR',
            status: client,
            retryable,
            upstreamStatus: upstream
          });
          expect(inspect(outcome.error)).not.toContain(privateMarker);
        }
        expectTransportRequest();
      } finally {
        fixture.release();
        controller.abort();
        await settle(operation);
      }
      expectNoPrivateData('');
    }
  );

  it('preserves a successful SDP answer and the configured model header', async () => {
    const response = await callWithReadableResponse(
      new Response(answer, { status: 200 }),
      'successful SDP'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/sdp');
    expect(response.headers.get('X-STT-Model')).toBe(sttModels.realtime);
    expect(await response.text()).toBe(answer);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expectTransportRequest();
    expectNoPrivateData('');
  });

  it('denies an unauthenticated request before its body or upstream', async () => {
    const incoming = request({ authenticated: false });
    const readBody = vi.spyOn(incoming, 'text');
    const response = await bounded(realtimeCall(incoming), 'authentication denial');
    expect(response.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
    expectNoPrivateData(await response.text());
  });

  it('returns a retryable timeout for a preaborted authenticated request', async () => {
    const controller = new AbortController();
    controller.abort();
    const incoming = request({ signal: controller.signal });
    const readBody = vi.spyOn(incoming, 'text');
    const response = await bounded(realtimeCall(incoming), 'preaborted request');
    expect(response.status).toBe(504);
    const responseText = await response.text();
    expect((JSON.parse(responseText) as ErrorBody).error).toMatchObject({
      code: 'TIMEOUT',
      retryable: true
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
    expectNoPrivateData(responseText);
  });

  it('propagates a genuine in-flight caller cancellation', async () => {
    const controller = new AbortController();
    let signalStarted: (signal: AbortSignal) => void = () => {};
    const started = new Promise<AbortSignal>((resolve) => {
      signalStarted = resolve;
    });
    transportPlan = holdUntilAbort(signalStarted);
    const operation = realtimeCall(request({ signal: controller.signal }));
    try {
      const upstreamSignal = await bounded(started, 'upstream request to start');
      expect(upstreamSignal.aborted).toBe(false);
      controller.abort();
      const response = await bounded(operation, 'in-flight cancellation');
      expect(upstreamSignal.aborted).toBe(true);
      expect(response.status).toBe(504);
      const responseText = await response.text();
      expect((JSON.parse(responseText) as ErrorBody).error).toMatchObject({
        code: 'TIMEOUT',
        retryable: true
      });
      expectTransportRequest();
      expectNoPrivateData(responseText);
    } finally {
      controller.abort();
      await settle(operation);
    }
  });

  it('retains the genuine in-flight server timeout without caller cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let signalStarted: (signal: AbortSignal) => void = () => {};
    const started = new Promise<AbortSignal>((resolve) => {
      signalStarted = resolve;
    });
    transportPlan = holdUntilAbort(signalStarted);
    const operation = realtimeCall(request({ signal: controller.signal }));
    try {
      const upstreamSignal = await bounded(started, 'upstream request to start');
      expect(upstreamSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(appLimits.realtimeSessionTimeoutMs);
      const response = await bounded(operation, 'in-flight server timeout');
      expect(controller.signal.aborted).toBe(false);
      expect(upstreamSignal.aborted).toBe(true);
      expect(response.status).toBe(504);
      const responseText = await response.text();
      expect((JSON.parse(responseText) as ErrorBody).error).toMatchObject({
        code: 'TIMEOUT',
        retryable: true
      });
      expectTransportRequest();
      expectNoPrivateData(responseText);
    } finally {
      controller.abort();
      await settle(operation);
      vi.useRealTimers();
    }
  });
});
