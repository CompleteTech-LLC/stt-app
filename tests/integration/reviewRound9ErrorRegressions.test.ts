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

const privateMarker = 'SYNTHETIC_PRIVATE_PROVIDER_DIAGNOSTIC';
const authorization = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
const logMethods = ['info', 'warn', 'error'] as const;
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const transcriptionEndpoint = 'https://api.openai.com/v1/audio/transcriptions';

function syntheticSdkTransport(
  handleTranscription: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) {
  const probe = vi.fn(() => Promise.resolve(new Response()));
  const transcription = vi.fn(handleTranscription);
  const unexpected = vi.fn<(url: string, method: string) => Promise<never>>(() =>
    Promise.reject(new Error('Unexpected synthetic SDK transport request'))
  );
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (input === 'data:,' && init === undefined) return probe();
    const url = input instanceof Request ? input.url : String(input);
    const requestMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const method = requestMethod.toUpperCase();
    if (url === transcriptionEndpoint && method === 'POST') return transcription(input, init);
    return unexpected(url, method);
  });
  return { fetch, probe, transcription, unexpected };
}

function expectSyntheticSdkTransport(transport: ReturnType<typeof syntheticSdkTransport>) {
  expect(transport.probe).toHaveBeenCalledTimes(1);
  expect(transport.unexpected).not.toHaveBeenCalled();
  expect(transport.transcription).toHaveBeenCalledTimes(1);
  const [input, init] = transport.transcription.mock.calls[0];
  expect(input instanceof Request ? input.url : String(input)).toBe(transcriptionEndpoint);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  expect(method.toUpperCase()).toBe('POST');
}

function uploadRequest(signal?: AbortSignal) {
  const form = new FormData();
  form.set('file', new File(['synthetic audio'], 'fixture.mp3', { type: 'audio/mpeg' }));
  form.set('model', 'gpt-4o-mini-transcribe');
  form.set('language', 'en');
  return new NextRequest('http://localhost/api/transcribe', {
    method: 'POST',
    headers: { authorization, origin: 'http://localhost' },
    body: form,
    signal
  });
}

function installSdk(transport: typeof fetch, timeout = 1000) {
  const client = new OpenAI({
    apiKey: 'synthetic-test-key',
    timeout,
    maxRetries: 0,
    fetch: transport
  });
  clientFactory.create.mockReturnValue(client);
}

function expectNoPrivateDiagnostics(responseBody: string) {
  expect(responseBody).not.toContain(privateMarker);
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

describe('authenticated SDK provider status precedence', () => {
  const statuses = [
    { upstream: 401, response: 503, retryable: false },
    { upstream: 403, response: 502, retryable: false },
    { upstream: 429, response: 502, retryable: false },
    { upstream: 500, response: 502, retryable: true },
    { upstream: 503, response: 502, retryable: true }
  ] as const;

  it.each(
    statuses.flatMap((status) =>
      ['timeout', 'timed out'].map((wording) => ({ ...status, wording }))
    )
  )(
    'maps HTTP $upstream independently of private "$wording" text',
    async ({ upstream, response: expectedStatus, retryable, wording }) => {
      const transport = syntheticSdkTransport(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: `${privateMarker} ${wording}`,
                code: `${privateMarker}_CODE`,
                type: `${privateMarker}_TYPE`
              }
            }),
            { status: upstream, headers: { 'content-type': 'application/json' } }
          )
      );
      installSdk(transport.fetch as typeof fetch);

      const response = await POST(uploadRequest());
      const text = await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'UPSTREAM_ERROR', retryable, upstreamStatus: upstream }
      });
      if (upstream === 401) {
        expect(JSON.parse(text).error.message).toBe('OpenAI rejected the server API key.');
      }
      expect(clientFactory.create).toHaveBeenCalledTimes(1);
      expectSyntheticSdkTransport(transport);
      expect(fetch).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'transcription_failed',
        expect.objectContaining({ code: 'UPSTREAM_ERROR', status: expectedStatus, retryable })
      );
      expectNoPrivateDiagnostics(text);
    }
  );

  it('retains a genuine SDK transport timeout with an un-aborted client signal', async () => {
    let transportSignal: AbortSignal | undefined;
    const transport = syntheticSdkTransport((input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!signal) throw new Error('SDK transport did not supply a signal');
      transportSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException(`${privateMarker} transport`, 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });
    installSdk(transport.fetch as typeof fetch, 80);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response;
    let clientAbortedAtResponse: boolean | undefined;
    let transportAbortedAtResponse: boolean | undefined;
    try {
      response = await Promise.race([
        POST(uploadRequest(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out waiting for SDK timeout response')),
            2000
          );
        })
      ]);
      clientAbortedAtResponse = controller.signal.aborted;
      transportAbortedAtResponse = transportSignal?.aborted;
    } finally {
      if (timer) clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
    const text = await response.text();

    expectSyntheticSdkTransport(transport);
    expect(fetch).not.toHaveBeenCalled();
    expect(clientAbortedAtResponse).toBe(false);
    expect(transportAbortedAtResponse).toBe(true);
    expect(response.status).toBe(504);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'TIMEOUT', retryable: true } });
    expect(logger.error).toHaveBeenCalledWith(
      'transcription_failed',
      expect.objectContaining({ code: 'TIMEOUT', status: 504, retryable: true })
    );
    expectNoPrivateDiagnostics(text);
  }, 5000);
});
