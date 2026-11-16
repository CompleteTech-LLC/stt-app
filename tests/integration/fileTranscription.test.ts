// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';

import { POST as transcribe } from '@/app/api/transcribe/route';
import { transcribeFile } from '@/src/server/fileTranscription';
import { resetRateLimits } from '@/src/server/rateLimit';

const clientFactory = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/src/server/openaiClient', () => ({ createOpenAIClient: clientFactory.create }));

const input = () => ({
  file: new File(['fake audio'], 'meeting.mp3', { type: 'audio/mpeg' }),
  language: 'en',
  model: 'gpt-4o-mini-transcribe' as const,
  prompt: 'Meeting about Signal STT.'
});

const clientWith = (create: unknown) => ({ audio: { transcriptions: { create } } }) as never;

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

const abortableTransport = () => {
  let upstreamStarted!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => (upstreamStarted = resolve));
  const transport = syntheticSdkTransport((input, options) => {
    const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (!signal) throw new Error('Expected an SDK transport signal.');
    upstreamStarted(signal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  });
  return { ...transport, started };
};

describe('OpenAI file transcription integration', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request in synthetic test')))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'] as const)(
    'passes %s options without overriding the SDK timeout',
    async (model) => {
      const create = vi.fn().mockResolvedValue({ text: '  Mock transcript.\n' });

      const result = await transcribeFile({ ...input(), model }, clientWith(create));

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          model,
          language: 'en',
          prompt: 'Meeting about Signal STT.',
          response_format: 'json'
        }),
        undefined
      );
      expect(result.text).toBe('  Mock transcript.\n');
      expect(result.segments).toEqual([]);
    }
  );

  it('does not read the file or create a client when already cancelled', async () => {
    const controller = new AbortController();
    const request = input();
    const read = vi.spyOn(request.file, 'arrayBuffer');
    clientFactory.create.mockClear();
    controller.abort();

    await expect(transcribeFile({ ...request, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(read).not.toHaveBeenCalled();
    expect(clientFactory.create).not.toHaveBeenCalled();
  });

  it('does not start upstream work if cancellation occurs while reading the file', async () => {
    const controller = new AbortController();
    const request = input();
    const create = vi.fn();
    let finishRead!: (buffer: ArrayBuffer) => void;
    vi.spyOn(request.file, 'arrayBuffer').mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve))
    );

    const pending = transcribeFile({ ...request, signal: controller.signal }, clientWith(create));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    finishRead(new Uint8Array([1]).buffer);
    await rejected;
    expect(create).not.toHaveBeenCalled();
  });

  it('forwards cancellation in the SDK request options while the call is pending', async () => {
    const controller = new AbortController();
    let upstreamStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => (upstreamStarted = resolve));
    const create = vi.fn((_body: unknown, options: { signal: AbortSignal }) => {
      upstreamStarted(options.signal);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      });
    });

    const pending = transcribeFile({ ...input(), signal: controller.signal }, clientWith(create));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const upstreamSignal = await started;
    expect(create.mock.calls[0][1]).toEqual({ signal: controller.signal });
    expect(upstreamSignal.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(upstreamSignal.aborted).toBe(true);
  });

  it('passes an SDK timeout error through unchanged when a client signal is present', async () => {
    const timeout = new Error('Request timed out.');
    const create = vi.fn().mockRejectedValue(timeout);
    const controller = new AbortController();

    await expect(
      transcribeFile({ ...input(), signal: controller.signal }, clientWith(create))
    ).rejects.toBe(timeout);
    expect(create.mock.calls[0][1]).toEqual({ signal: controller.signal });
    expect(controller.signal.aborted).toBe(false);
  });

  it('does not return a late SDK success after the client cancels', async () => {
    const controller = new AbortController();
    let upstreamStarted!: () => void;
    let finishUpstream!: (result: { text: string }) => void;
    const started = new Promise<void>((resolve) => (upstreamStarted = resolve));
    const create = vi.fn(() => {
      upstreamStarted();
      return new Promise<{ text: string }>((resolve) => (finishUpstream = resolve));
    });
    const pending = transcribeFile({ ...input(), signal: controller.signal }, clientWith(create));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    controller.abort();
    finishUpstream({ text: 'late result' });
    await rejected;
  });

  it('propagates cancellation through the real SDK to a synthetic transport', async () => {
    const transport = abortableTransport();
    const sdk = new OpenAI({
      apiKey: 'synthetic-test-key',
      timeout: 1000,
      maxRetries: 0,
      fetch: transport.fetch as typeof fetch
    });
    const controller = new AbortController();
    const pending = transcribeFile({ ...input(), signal: controller.signal }, sdk);
    const rejected = expect(pending).rejects.toBeDefined();
    try {
      const upstreamSignal = await bounded(
        Promise.race([
          transport.started,
          pending.then(
            () => Promise.reject(new Error('SDK request completed before reaching the transport.')),
            (error: unknown) => Promise.reject(error)
          )
        ]),
        'SDK transport'
      );
      expect(upstreamSignal.aborted).toBe(false);
      controller.abort();
      await bounded(Promise.resolve(rejected), 'SDK cancellation');
      expect(upstreamSignal.aborted).toBe(true);
      expectSyntheticSdkTransport(transport);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (!controller.signal.aborted) controller.abort();
    }
  });

  it('preserves the real SDK timeout with a client signal and synthetic transport', async () => {
    const transport = abortableTransport();
    const sdk = new OpenAI({
      apiKey: 'synthetic-test-key',
      timeout: 40,
      maxRetries: 0,
      fetch: transport.fetch as typeof fetch
    });
    const controller = new AbortController();
    const pending = transcribeFile({ ...input(), signal: controller.signal }, sdk);
    const rejected = expect(pending).rejects.toBeDefined();
    try {
      const upstreamSignal = await bounded(
        Promise.race([
          transport.started,
          pending.then(
            () => Promise.reject(new Error('SDK request completed before reaching the transport.')),
            (error: unknown) => Promise.reject(error)
          )
        ]),
        'SDK transport'
      );
      await bounded(Promise.resolve(rejected), 'SDK timeout');
      expect(upstreamSignal.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      expectSyntheticSdkTransport(transport);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (!controller.signal.aborted) controller.abort();
    }
  });

  it('retains synthetic complete alignment only when all segments match the original text', async () => {
    const segments = [
      { id: 0, start: 0, end: 1, text: '  First' },
      { id: 1, start: 1, end: 2, text: ' second  ' }
    ];
    const create = vi.fn().mockResolvedValue({ text: '  First second  ', segments });
    const result = await transcribeFile(input(), clientWith(create));
    expect(result.text).toBe('  First second  ');
    expect(result.segments).toEqual(segments);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['not an array', { start: 0, end: 1, text: 'First' }],
    ['mixed missing time', [{ start: 0, end: 1, text: 'First' }, { text: 'second' }]],
    ['null cue', [{ start: 0, end: 1, text: 'First' }, null]],
    ['missing text', [{ start: 0, end: 1 }]],
    ['negative time', [{ start: -1, end: 1, text: 'First second' }]],
    ['reversed time', [{ start: 2, end: 1, text: 'First second' }]],
    ['non-finite time', [{ start: 0, end: Infinity, text: 'First second' }]],
    ['partial text', [{ start: 0, end: 1, text: 'First' }]]
  ])('discards %s provider segments while retaining text', async (_label, segments) => {
    const create = vi.fn().mockResolvedValue({ text: '  First second\n', segments });
    const result = await transcribeFile(input(), clientWith(create));
    expect(result.text).toBe('  First second\n');
    expect(result.segments).toEqual([]);
  });
});

describe('authenticated upload route with the real SDK and synthetic transport', () => {
  const marker = 'synthetic-private-sdk-detail';
  const authorization = `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`;

  const uploadRequest = (signal?: AbortSignal) => {
    const form = new FormData();
    form.set('file', new File(['synthetic audio'], 'synthetic.mp3', { type: 'audio/mpeg' }));
    form.set('model', 'gpt-4o-mini-transcribe');
    return new NextRequest('http://localhost/api/transcribe', {
      method: 'POST',
      headers: { authorization, origin: 'http://localhost' },
      body: form,
      signal
    });
  };

  beforeEach(() => {
    vi.stubEnv('BASIC_AUTH_USER', 'synthetic-user');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'synthetic-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
    vi.stubEnv('MAX_UPLOAD_BYTES', '26214400');
    vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '100');
    vi.stubEnv('LOG_TRANSCRIPTS', 'false');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request in synthetic test')))
    );
    clientFactory.create.mockReset();
    resetRateLimits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clientFactory.create.mockReset();
    resetRateLimits();
  });

  it.each([
    ['default', (): undefined => undefined],
    ['Error', (): Error => new Error(`${marker}-reason`)],
    ['string', (): string => `${marker}-reason`],
    ['null', (): null => null]
  ] as const)('maps in-flight %s cancellation through the real SDK', async (_label, reason) => {
    const transport = abortableTransport();
    const sdk = new OpenAI({
      apiKey: 'synthetic-test-key',
      timeout: 1000,
      maxRetries: 1,
      fetch: transport.fetch as typeof fetch
    });
    clientFactory.create.mockReturnValue(sdk);
    const errorLog = vi.spyOn(console, 'error');
    const infoLog = vi.spyOn(console, 'info');
    const controller = new AbortController();
    const pending = transcribe(uploadRequest(controller.signal));
    try {
      const upstreamSignal = await bounded(
        Promise.race([
          transport.started,
          pending.then(() => {
            throw new Error('Upload ended before reaching the synthetic SDK transport.');
          })
        ]),
        'SDK transport'
      );
      expect(upstreamSignal.aborted).toBe(false);
      controller.abort(reason());
      const response = await bounded(pending, 'cancelled route response');
      const body = await response.text();

      expect(clientFactory.create).toHaveBeenCalledTimes(1);
      expect(upstreamSignal.aborted).toBe(true);
      expectSyntheticSdkTransport(transport);
      expect(fetch).not.toHaveBeenCalled();
      expect(response.status).toBe(504);
      expect(JSON.parse(body).error).toMatchObject({ code: 'TIMEOUT', retryable: true });
      expect(body).not.toContain(marker);
      expect(JSON.stringify([...errorLog.mock.calls, ...infoLog.mock.calls])).not.toContain(marker);
    } finally {
      if (!controller.signal.aborted) controller.abort();
    }
  });

  it('maps a real SDK timeout without an aborted client signal', async () => {
    const transport = abortableTransport();
    const sdk = new OpenAI({
      apiKey: 'synthetic-test-key',
      timeout: 40,
      maxRetries: 0,
      fetch: transport.fetch as typeof fetch
    });
    clientFactory.create.mockReturnValue(sdk);
    const errorLog = vi.spyOn(console, 'error');
    const controller = new AbortController();
    const pending = transcribe(uploadRequest(controller.signal));
    try {
      const upstreamSignal = await bounded(
        Promise.race([
          transport.started,
          pending.then(() => {
            throw new Error('Upload ended before reaching the synthetic SDK transport.');
          })
        ]),
        'SDK transport'
      );
      const response = await bounded(pending, 'SDK timeout response');
      const body = await response.text();

      expect(controller.signal.aborted).toBe(false);
      expect(upstreamSignal.aborted).toBe(true);
      expectSyntheticSdkTransport(transport);
      expect(fetch).not.toHaveBeenCalled();
      expect(response.status).toBe(504);
      expect(JSON.parse(body).error).toMatchObject({ code: 'TIMEOUT', retryable: true });
      expect(body).not.toContain(marker);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(marker);
    } finally {
      if (!controller.signal.aborted) controller.abort();
    }
  });

  it.each(
    [401, 403, 429, 503].flatMap((status) =>
      ['timeout', 'timed out'].map((wording) => [status, wording] as const)
    )
  )('maps real SDK HTTP %i with %s diagnostics', async (status, wording) => {
    const transport = syntheticSdkTransport(
      async () =>
        new Response(
          JSON.stringify({ error: { message: `${marker}-${wording}`, code: `${marker}-code` } }),
          { status, headers: { 'content-type': 'application/json' } }
        )
    );
    const sdk = new OpenAI({
      apiKey: 'synthetic-test-key',
      timeout: 1000,
      maxRetries: 0,
      fetch: transport.fetch as typeof fetch
    });
    clientFactory.create.mockReturnValue(sdk);
    const errorLog = vi.spyOn(console, 'error');
    const infoLog = vi.spyOn(console, 'info');
    const controller = new AbortController();
    const response = await transcribe(uploadRequest(controller.signal));
    const body = await response.text();

    expect(controller.signal.aborted).toBe(false);
    expectSyntheticSdkTransport(transport);
    expect(fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(status === 401 ? 503 : 502);
    expect(JSON.parse(body).error).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: status >= 500,
      upstreamStatus: status
    });
    expect(body).not.toContain(marker);
    expect(JSON.stringify([...errorLog.mock.calls, ...infoLog.mock.calls])).not.toContain(marker);
  });
});
