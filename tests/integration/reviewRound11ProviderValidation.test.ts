// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as realtimeCall } from '@/app/api/realtime/call/route';
import { POST as transcribe } from '@/app/api/transcribe/route';
import { transcribeFile } from '@/src/server/fileTranscription';
import { resetRateLimits } from '@/src/server/rateLimit';

const synthetic = vi.hoisted(() => ({
  config: {} as Record<string, string | undefined>,
  createClient: vi.fn()
}));

vi.mock('@/src/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/src/lib/config')>();
  return {
    ...original,
    getServerConfig: () => original.getServerConfig(synthetic.config)
  };
});
vi.mock('@/src/server/openaiClient', () => ({ createOpenAIClient: synthetic.createClient }));

const marker = 'synthetic-private-provider-detail';
const credentials = Buffer.from('synthetic-user:synthetic-password').toString('base64');
const authorization = `Basic ${credentials}`;
const invalidResponseMessage = 'OpenAI transcription service returned an invalid response.';
const malformedResponses: Array<[string, unknown]> = [
  ['null result', null],
  ['undefined result', undefined],
  ['array result', [{ text: marker }]],
  ['array with a text property', Object.assign([], { text: marker })],
  ['string result', marker],
  ['number result', 42],
  ['boolean result', false],
  ['missing text', { diagnostic: marker }],
  ['null text', { text: null, diagnostic: marker }],
  ['number text', { text: 0, diagnostic: marker }],
  ['boolean text', { text: false, diagnostic: marker }],
  ['array text', { text: [marker] }],
  ['object text', { text: { message: marker } }]
];

const input = () => ({
  file: new File([`${marker}-audio`], 'synthetic.mp3', { type: 'audio/mpeg' }),
  language: 'en',
  model: 'gpt-4o-mini-transcribe' as const,
  prompt: `${marker}-prompt`
});

const uploadRequest = (signal?: AbortSignal, authenticated = true) => {
  const form = new FormData();
  const values = input();
  form.set('file', values.file);
  form.set('language', values.language);
  form.set('model', values.model);
  form.set('prompt', values.prompt);
  return new NextRequest('http://localhost/api/transcribe', {
    method: 'POST',
    headers: authenticated ? { authorization, origin: 'http://localhost' } : undefined,
    body: form,
    signal
  });
};

const realtimeRequest = (signal?: AbortSignal, authenticated = true) =>
  new NextRequest('http://localhost/api/realtime/call', {
    method: 'POST',
    headers: authenticated ? { authorization, origin: 'http://localhost' } : undefined,
    body: 'v=0\r\na=synthetic-offer\r\n',
    signal
  });

const capturedLogs = () =>
  JSON.stringify([
    ...vi.mocked(console.info).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls
  ]);

beforeEach(() => {
  synthetic.config = {
    OPENAI_API_KEY: 'synthetic-test-key',
    RATE_LIMIT_MAX_REQUESTS: '100'
  };
  synthetic.createClient.mockReset();
  vi.stubEnv('BASIC_AUTH_USER', 'synthetic-user');
  vi.stubEnv('BASIC_AUTH_PASSWORD', 'synthetic-password');
  vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request in synthetic test')))
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetRateLimits();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  synthetic.createClient.mockReset();
  resetRateLimits();
});

describe('file transcription response validation', () => {
  it.each(malformedResponses)('rejects %s in the actual adapter', async (_label, result) => {
    const create = vi.fn().mockResolvedValue(result);
    const client = { audio: { transcriptions: { create } } };

    await expect(transcribeFile(input(), client as never)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: invalidResponseMessage,
      status: 502,
      retryable: false
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-mini-transcribe',
        language: 'en',
        prompt: `${marker}-prompt`,
        response_format: 'json'
      }),
      undefined
    );
  });

  it.each(malformedResponses)(
    'returns a sanitized non-success for %s through the authenticated upload route',
    async (_label, result) => {
      const create = vi.fn().mockResolvedValue(result);
      synthetic.createClient.mockReturnValue({ audio: { transcriptions: { create } } });
      const request = uploadRequest();

      const response = await transcribe(request);
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(body).toEqual({
        error: { code: 'UPSTREAM_ERROR', message: invalidResponseMessage, retryable: false }
      });
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ response_format: 'json', model: 'gpt-4o-mini-transcribe' }),
        { signal: request.signal }
      );
      expect(JSON.stringify(body)).not.toContain(marker);
      expect(capturedLogs()).toContain('transcription_failed');
      expect(capturedLogs()).not.toContain('transcription_completed');
      expect(capturedLogs()).not.toContain(marker);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['genuine empty', ''],
    ['normal with whitespace', '  synthetic transcript\n']
  ])('accepts %s text through the actual adapter and route', async (_label, text) => {
    const create = vi.fn().mockResolvedValue({ text });
    synthetic.createClient.mockReturnValue({ audio: { transcriptions: { create } } });
    const request = uploadRequest();

    const response = await transcribe(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.transcript).toMatchObject({
      text,
      language: 'en',
      model: 'gpt-4o-mini-transcribe',
      segments: []
    });
    expect(body.transcript.createdAt).toEqual(expect.any(String));
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: 'json', model: 'gpt-4o-mini-transcribe' }),
      { signal: request.signal }
    );
    expect(capturedLogs()).toContain('transcription_completed');
    expect(capturedLogs()).not.toContain(marker);
    if (text) expect(capturedLogs()).not.toContain(text.trim());
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['null cue', [{ start: 0, end: 1, text: 'One' }, null]],
    ['missing cue text', [{ start: 0, end: 1 }]],
    ['negative time', [{ start: -1, end: 1, text: 'One two' }]],
    ['mismatched cue text', [{ start: 0, end: 1, text: 'One' }]]
  ])('retains valid text but discards %s through the route', async (_label, segments) => {
    const create = vi.fn().mockResolvedValue({ text: '  One two\n', segments });
    synthetic.createClient.mockReturnValue({ audio: { transcriptions: { create } } });

    const response = await transcribe(uploadRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.transcript).toMatchObject({ text: '  One two\n', segments: [] });
    expect(create).toHaveBeenCalledOnce();
    expect(capturedLogs()).not.toContain('One two');
  });

  it('checks authentication before parsing an already-cancelled upload', async () => {
    const controller = new AbortController();
    controller.abort(`${marker}-cancel`);
    const request = uploadRequest(controller.signal, false);
    const readForm = vi.spyOn(request, 'formData');

    const response = await transcribe(request);

    expect(response.status).toBe(401);
    expect(readForm).not.toHaveBeenCalled();
    expect(synthetic.createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not parse or create an SDK client for an authenticated pre-aborted upload', async () => {
    const controller = new AbortController();
    controller.abort(`${marker}-cancel`);
    const request = uploadRequest(controller.signal);
    const readForm = vi.spyOn(request, 'formData');

    const response = await transcribe(request);
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(body.error).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(readForm).not.toHaveBeenCalled();
    expect(synthetic.createClient).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(capturedLogs()).not.toContain(marker);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives cancellation precedence over a late malformed SDK response', async () => {
    const controller = new AbortController();
    let announceStart!: (signal: AbortSignal) => void;
    let finishUpstream!: (result: unknown) => void;
    const started = new Promise<AbortSignal>((resolve) => (announceStart = resolve));
    const create = vi.fn((_body: unknown, options: { signal: AbortSignal }) => {
      announceStart(options.signal);
      return new Promise<unknown>((resolve) => (finishUpstream = resolve));
    });
    synthetic.createClient.mockReturnValue({ audio: { transcriptions: { create } } });
    const request = uploadRequest(controller.signal);
    const pending = transcribe(request);

    const upstreamSignal = await started;
    expect(upstreamSignal).toBe(request.signal);
    expect(create.mock.calls[0][1].signal).toBe(request.signal);
    controller.abort(`${marker}-cancel`);
    finishUpstream({ text: null, diagnostic: marker });
    const response = await pending;
    const body = await response.json();

    expect(request.signal.aborted).toBe(true);
    expect(upstreamSignal.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(body.error).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(capturedLogs()).not.toContain(marker);
    expect(capturedLogs()).not.toContain('transcription_completed');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('realtime response model provenance', () => {
  it.each([
    ['default', undefined, 'gpt-realtime-whisper'],
    ['override', 'synthetic-realtime-override', 'synthetic-realtime-override']
  ])('returns the actual %s model alongside the unchanged SDP', async (_label, override, model) => {
    synthetic.config.OPENAI_REALTIME_STT_MODEL = override;
    const answer = 'v=0\r\na=synthetic-answer\r\n';
    vi.mocked(fetch).mockResolvedValue(new Response(answer));
    const request = realtimeRequest();

    const response = await realtimeCall(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/sdp');
    expect(response.headers.get('x-stt-model')).toBe(model);
    expect(await response.text()).toBe(answer);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(options?.method).toBe('POST');
    const form = options?.body as FormData;
    expect(form.get('sdp')).toBe('v=0\r\na=synthetic-offer\r\n');
    expect(JSON.parse(String(form.get('session'))).audio.input).toEqual({
      transcription: { model, language: 'en', delay: 'low' },
      turn_detection: null
    });
  });

  it('does not read or contact upstream before realtime authentication', async () => {
    const controller = new AbortController();
    controller.abort(`${marker}-cancel`);
    const request = realtimeRequest(controller.signal, false);
    const readText = vi.spyOn(request, 'text');

    const response = await realtimeCall(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('x-stt-model')).toBeNull();
    expect(readText).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not return model metadata after realtime cancellation', async () => {
    const controller = new AbortController();
    let announceStart!: () => void;
    let finishUpstream!: (response: Response) => void;
    const started = new Promise<void>((resolve) => (announceStart = resolve));
    vi.mocked(fetch).mockImplementation(() => {
      announceStart();
      return new Promise<Response>((resolve) => (finishUpstream = resolve));
    });
    const request = realtimeRequest(controller.signal);
    const pending = realtimeCall(request);

    await started;
    controller.abort(`${marker}-cancel`);
    finishUpstream(new Response('v=0\r\na=synthetic-answer\r\n'));
    const response = await pending;
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(response.headers.get('x-stt-model')).toBeNull();
    expect(body.error).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(capturedLogs()).not.toContain(marker);
  });
});
