// @vitest-environment node

import { inspect } from 'node:util';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as realtime } from '@/app/api/realtime/call/route';
import { POST as upload } from '@/app/api/transcribe/route';
import { logger } from '@/src/lib/logging';
import { transcribeFile } from '@/src/server/fileTranscription';
import { resetRateLimits } from '@/src/server/rateLimit';

const sdk = vi.hoisted(() => ({ createClient: vi.fn(), createTranscription: vi.fn() }));

vi.mock('@/src/server/openaiClient', () => ({ createOpenAIClient: sdk.createClient }));

const privateMarker = 'SYNTHETIC_PRIVATE_PROVIDER_PAYLOAD_11';
const authorization = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
const model = 'gpt-4o-mini-transcribe';
const logMethods = ['info', 'warn', 'error'] as const;
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const malformed = [
  { label: 'null response', value: null },
  { label: 'array response', value: [] },
  { label: 'scalar response', value: privateMarker },
  { label: 'missing text', value: { diagnostic: privateMarker } },
  { label: 'null text', value: { text: null, diagnostic: privateMarker } },
  { label: 'numeric text', value: { text: 42, diagnostic: privateMarker } },
  { label: 'object text', value: { text: { detail: privateMarker } } },
  { label: 'array text', value: { text: [privateMarker] } }
];

let unexpectedRequests: string[];
let realtimeResponsesAllowed: number;
let realtimeForms: FormData[];

function adapterInput(signal?: AbortSignal) {
  return {
    file: new File(['synthetic audio'], 'fixture.mp3', { type: 'audio/mpeg' }),
    language: 'auto',
    model,
    signal
  } as const;
}

function uploadRequest(options: { authenticated?: boolean; signal?: AbortSignal } = {}) {
  const form = new FormData();
  form.set('file', new File(['synthetic audio'], 'fixture.mp3', { type: 'audio/mpeg' }));
  form.set('model', model);
  form.set('language', 'auto');
  return new NextRequest('http://localhost/api/transcribe', {
    method: 'POST',
    headers: {
      ...(options.authenticated === false ? {} : { authorization }),
      origin: 'http://localhost'
    },
    body: form,
    signal: options.signal
  });
}

function realtimeRequest(authenticated = true) {
  return new NextRequest('http://localhost/api/realtime/call?language=en&delay=low', {
    method: 'POST',
    headers: {
      ...(authenticated ? { authorization } : {}),
      origin: 'http://localhost',
      'Content-Type': 'application/sdp'
    },
    body: 'v=0\r\nsynthetic offer\r\n'
  });
}

function expectPrivateDataAbsent(responseText: string) {
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

beforeEach(() => {
  unexpectedRequests = [];
  realtimeResponsesAllowed = 0;
  realtimeForms = [];
  vi.stubEnv('BASIC_AUTH_USER', 'fixture-user');
  vi.stubEnv('BASIC_AUTH_PASSWORD', 'fixture-password');
  vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  vi.stubEnv('LOG_TRANSCRIPTS', 'false');
  vi.stubEnv('OPENAI_REALTIME_STT_MODEL', 'synthetic-realtime-override');
  sdk.createClient.mockReset();
  sdk.createTranscription.mockReset();
  sdk.createClient.mockReturnValue({
    audio: { transcriptions: { create: sdk.createTranscription } }
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (
        url === 'https://api.openai.com/v1/realtime/calls' &&
        init?.method === 'POST' &&
        init.body instanceof FormData &&
        realtimeResponsesAllowed > 0
      ) {
        realtimeResponsesAllowed -= 1;
        realtimeForms.push(init.body);
        return Promise.resolve(new Response('v=0\r\nsynthetic answer\r\n', { status: 200 }));
      }
      unexpectedRequests.push(`${init?.method || 'GET'} ${url}`);
      return Promise.reject(new Error('Unexpected synthetic transport request'));
    })
  );
  resetRateLimits();
  for (const method of consoleMethods) vi.spyOn(console, method);
  for (const method of logMethods) vi.spyOn(logger, method);
});

afterEach(() => {
  try {
    expect(unexpectedRequests).toEqual([]);
    expect(realtimeResponsesAllowed).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRateLimits();
  }
});

describe('file transcription provider response validation', () => {
  it.each(malformed)('rejects $label in the actual adapter', async ({ value }) => {
    sdk.createTranscription.mockResolvedValue(value);
    await expect(transcribeFile(adapterInput())).rejects.toBeDefined();
    expect(sdk.createTranscription).toHaveBeenCalledOnce();
    expect(sdk.createTranscription).toHaveBeenCalledWith(
      expect.objectContaining({ model, language: undefined, response_format: 'json' }),
      undefined
    );
    expectPrivateDataAbsent('');
  });

  it.each(malformed)(
    'returns sanitized non-success for $label through the authenticated route',
    async ({ value }) => {
      sdk.createTranscription.mockResolvedValue(value);
      const response = await upload(uploadRequest());
      const body = await response.text();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(600);
      expect(JSON.parse(body)).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String) }) })
      );
      expect(JSON.parse(body)).not.toHaveProperty('transcript');
      expect(sdk.createTranscription).toHaveBeenCalledOnce();
      expectPrivateDataAbsent(body);
    }
  );

  it.each(['', '  Valid speech.\n'])(
    'accepts a genuine string text value %j without inventing timestamp segments',
    async (providerText) => {
      sdk.createTranscription.mockResolvedValue({ text: providerText });
      const direct = await transcribeFile(adapterInput());
      expect(direct.text).toBe(providerText);
      expect(direct.segments).toEqual([]);
      const response = await upload(uploadRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.transcript.text).toBe(providerText);
      expect(body.transcript.segments).toEqual([]);
      expect(sdk.createTranscription).toHaveBeenCalledTimes(2);
    }
  );

  it('authenticates before reading the upload or calling the adapter', async () => {
    const request = uploadRequest({ authenticated: false });
    const readBody = vi.spyOn(request, 'formData');
    const response = await upload(request);
    expect(response.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(sdk.createClient).not.toHaveBeenCalled();
    expect(sdk.createTranscription).not.toHaveBeenCalled();
    expectPrivateDataAbsent(await response.text());
  });

  it('does not start the SDK for an authenticated pre-aborted upload', async () => {
    const controller = new AbortController();
    controller.abort(new Error(privateMarker));
    const request = uploadRequest({ signal: controller.signal });
    const readBody = vi.spyOn(request, 'formData');
    const response = await upload(request);
    expect(response.status).toBe(504);
    expect(readBody).not.toHaveBeenCalled();
    expect(sdk.createTranscription).not.toHaveBeenCalled();
    expectPrivateDataAbsent(await response.text());
  });

  it('propagates an in-flight cancellation through the actual route and adapter', async () => {
    let reportSignal!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      reportSignal = resolve;
    });
    sdk.createTranscription.mockImplementation(
      (_parameters: unknown, options: { signal: AbortSignal }) => {
        reportSignal(options.signal);
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException(privateMarker, 'AbortError'));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
    );
    const controller = new AbortController();
    const result = upload(uploadRequest({ signal: controller.signal }));
    try {
      const signal = await bounded(
        Promise.race([
          started,
          result.then((response) => {
            throw new Error(`Route returned ${response.status} before the SDK started`);
          })
        ]),
        'SDK start'
      );
      expect(signal.aborted).toBe(false);
      controller.abort(new Error(privateMarker));
      const response = await bounded(result, 'cancelled route');
      expect(signal.aborted).toBe(true);
      expect(response.status).toBe(504);
      expectPrivateDataAbsent(await response.text());
    } finally {
      controller.abort();
    }
  });
});

describe('realtime selected-model response contract', () => {
  it.each(['gpt-realtime-whisper', 'synthetic-realtime-override'])(
    'exposes server-selected model %s on the authenticated SDP answer',
    async (selectedModel) => {
      vi.stubEnv('OPENAI_REALTIME_STT_MODEL', selectedModel);
      realtimeResponsesAllowed = 1;
      const response = await realtime(realtimeRequest());
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/application\/sdp/i);
      expect(response.headers.get('X-STT-Model')).toBe(selectedModel);
      expect(await response.text()).toBe('v=0\r\nsynthetic answer\r\n');
      expect(realtimeForms).toHaveLength(1);
      expect(realtimeForms[0].get('sdp')).toBe('v=0\r\nsynthetic offer\r\n');
      const session = JSON.parse(String(realtimeForms[0].get('session')));
      expect(session.audio.input.transcription.model).toBe(selectedModel);
      expect(session.audio.input.turn_detection).toBeNull();
    }
  );

  it('does not contact the realtime transport for an unauthenticated request', async () => {
    const request = realtimeRequest(false);
    const readBody = vi.spyOn(request, 'text');
    const response = await realtime(request);
    expect(response.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(response.headers.get('X-STT-Model')).toBeNull();
  });
});
