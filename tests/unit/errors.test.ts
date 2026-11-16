// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';

import { POST as transcribe } from '@/app/api/transcribe/route';
import { POST as realtimeCall } from '@/app/api/realtime/call/route';
import { AppError, errorResponseBody, getUpstreamStatus, toAppError } from '@/src/lib/errors';
import { validateUploadFile } from '@/src/lib/validation';
import { resetRateLimits } from '@/src/server/rateLimit';

const syntheticSdk = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/src/server/openaiClient', () => ({
  createOpenAIClient: () => ({ audio: { transcriptions: { create: syntheticSdk.create } } })
}));

describe('error mapping', () => {
  it('preserves structured app errors', () => {
    const error = new AppError('INVALID_FILE', 'Bad file', 415);

    expect(toAppError(error)).toBe(error);
    expect(errorResponseBody(toAppError(error)).error.message).toBe('Bad file');
  });

  it('preserves fixed upload validation guidance', () => {
    const file = new File(['synthetic data'], 'synthetic.unknown', {
      type: 'application/x-synthetic'
    });
    let validationError: unknown;
    try {
      validateUploadFile(file);
    } catch (error) {
      validationError = error;
    }

    expect(validationError).toBeInstanceOf(AppError);
    const mapped = toAppError(validationError);
    expect(mapped).toMatchObject({ code: 'INVALID_FILE', status: 415, retryable: false });
    expect(errorResponseBody(mapped).error.message).toBe(
      'Unsupported file type. Upload a common audio or video file.'
    );
  });

  it('maps missing API key safely', () => {
    const mapped = toAppError(new Error('OPENAI_API_KEY is missing'));

    expect(mapped.code).toBe('MISSING_API_KEY');
    expect(mapped.status).toBe(503);
    expect(mapped.message).not.toContain('sk-');
  });

  it('maps upstream auth errors without exposing secrets', () => {
    const mapped = toAppError(
      Object.assign(new Error('synthetic-private-credential timeout'), {
        status: 401,
        error: {
          message: 'synthetic-private-provider-detail',
          code: 'synthetic-private-provider-code'
        }
      })
    );

    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.status).toBe(503);
    expect(mapped.retryable).toBe(false);
    expect(mapped.message).toBe('OpenAI rejected the server API key.');
    expect(mapped.upstreamStatus).toBe(401);
    expect(mapped.upstreamCode).toBeUndefined();
    expect(JSON.stringify(errorResponseBody(mapped))).not.toContain('synthetic-private');
  });

  it.each([401, 403, 429, 503])('sanitizes SDK error details for HTTP %i', (status) => {
    const providerErrors = [
      Object.assign(new Error('synthetic-private-top-message'), {
        status,
        code: 'synthetic-private-top-code',
        type: 'synthetic-private-top-type'
      }),
      Object.assign(new Error('SDK request failed'), {
        status,
        error: {
          message: 'synthetic-private-nested-message',
          code: 'synthetic-private-nested-code',
          type: 'synthetic-private-nested-type'
        }
      }),
      Object.assign(new Error('SDK request failed'), {
        status,
        type: 'synthetic-private-top-type'
      }),
      Object.assign(new Error('SDK request failed'), {
        status,
        error: { type: 'synthetic-private-nested-type' }
      })
    ];

    for (const providerError of providerErrors) {
      const mapped = toAppError(providerError);
      expect(mapped).toMatchObject({
        code: 'UPSTREAM_ERROR',
        status: status === 401 ? 503 : 502,
        retryable: status >= 500,
        upstreamStatus: status
      });
      expect(mapped.message).toBe(
        status === 401
          ? 'OpenAI rejected the server API key.'
          : `OpenAI transcription service returned HTTP ${status}. Check the OpenAI project configuration and access, or retry later.`
      );
      expect(mapped.upstreamCode).toBeUndefined();
      expect(JSON.stringify(errorResponseBody(mapped))).not.toContain('synthetic-private');
    }
  });

  it.each([
    ['string', '503'],
    ['string with private text', '503 synthetic-private-status'],
    ['fractional', 503.5],
    ['non-finite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['below HTTP range', 99],
    ['above HTTP range', 600]
  ])('rejects %s upstream status values', (_description, status) => {
    expect(getUpstreamStatus(status)).toBeUndefined();
    const mapped = toAppError(
      Object.assign(new Error('synthetic-private-message'), {
        status,
        code: 'synthetic-private-code'
      })
    );
    expect(mapped).toMatchObject({ code: 'UNKNOWN_ERROR', status: 500, retryable: false });
    expect(mapped.upstreamStatus).toBeUndefined();
    expect(JSON.stringify(errorResponseBody(mapped))).not.toContain('synthetic-private');
  });

  it('maps the pinned SDK timeout with its default message', () => {
    const timeout = new OpenAI.APIConnectionTimeoutError();
    expect(timeout.message).toBe('Request timed out.');
    const mapped = toAppError(timeout);
    expect(mapped).toMatchObject({ code: 'TIMEOUT', status: 504, retryable: true });
    expect(mapped.message).toBe('The transcription request timed out. Try a shorter file.');
  });

  it.each([
    ['plain SDK timeout message', () => new Error('Request timed out.')],
    ['timed-out message', () => new Error('synthetic-private-provider-detail: Request timed out.')],
    ['timeout message', () => new Error('synthetic-private-provider-detail: socket timeout')],
    [
      'SDK timeout name',
      () =>
        Object.assign(new Error('synthetic-private-provider-detail'), {
          name: 'APIConnectionTimeoutError'
        })
    ],
    [
      'TimeoutError name',
      () => Object.assign(new Error('synthetic-private-provider-detail'), { name: 'TimeoutError' })
    ],
    [
      'AbortError name',
      () => Object.assign(new Error('synthetic-private-provider-detail'), { name: 'AbortError' })
    ]
  ] as const)('sanitizes the %s response', (_description, createError) => {
    const mapped = toAppError(createError());
    expect(mapped).toMatchObject({ code: 'TIMEOUT', status: 504, retryable: true });
    expect(errorResponseBody(mapped)).toEqual({
      error: {
        code: 'TIMEOUT',
        message: 'The transcription request timed out. Try a shorter file.',
        retryable: true,
        upstreamStatus: undefined,
        upstreamCode: undefined
      }
    });
    expect(JSON.stringify(errorResponseBody(mapped))).not.toContain('synthetic-private');
  });

  it('does not classify unrelated errors as timeouts or expose their messages', () => {
    const mapped = toAppError(new Error('synthetic-private-provider-detail'));
    expect(mapped).toMatchObject({ code: 'UNKNOWN_ERROR', status: 500, retryable: false });
    expect(JSON.stringify(errorResponseBody(mapped))).not.toContain('synthetic-private');
  });
});

describe('provider error boundaries', () => {
  const marker = 'synthetic-provider-private';
  const credentials = `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`;
  const providerShapes = [
    'top-level',
    'nested',
    'top-level-type-only',
    'nested-type-only'
  ] as const;
  const providerCases = [401, 403, 429, 503].flatMap((status) =>
    providerShapes.map((shape) => [status, shape] as const)
  );
  const providerDetails = (shape: (typeof providerShapes)[number]) => {
    const topLevel = shape.startsWith('top-level');
    const name = topLevel ? 'top' : 'nested';
    const details = {
      message: `${marker}-${name}-message`,
      ...(shape.endsWith('type-only') ? {} : { code: `${marker}-${name}-code` }),
      type: `${marker}-${name}-type`
    };
    return topLevel ? details : { error: details };
  };

  beforeEach(() => {
    vi.stubEnv('BASIC_AUTH_USER', 'synthetic-user');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'synthetic-password');
    vi.stubEnv('BASIC_AUTH_PUBLIC_ORIGIN', 'http://localhost');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request in synthetic test')))
    );
    syntheticSdk.create.mockReset();
    resetRateLimits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRateLimits();
  });

  it.each(providerCases)(
    'keeps SDK upload HTTP %i %s diagnostics out of responses and logs',
    async (status, shape) => {
      const details = providerDetails(shape);
      const providerError = Object.assign(new Error('SDK request failed'), details, { status });
      syntheticSdk.create.mockRejectedValueOnce(providerError);
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
      const form = new FormData();
      form.set('file', new File(['synthetic audio'], 'synthetic.mp3', { type: 'audio/mpeg' }));
      form.set('model', 'gpt-4o-mini-transcribe');

      const response = await transcribe(
        new NextRequest('http://localhost/api/transcribe', {
          method: 'POST',
          headers: { authorization: credentials },
          body: form
        })
      );
      const responseText = await response.text();
      const responseBody = JSON.parse(responseText) as { error: Record<string, unknown> };

      expect(syntheticSdk.create).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(response.status).toBe(status === 401 ? 503 : 502);
      expect(responseBody.error).toEqual({
        code: 'UPSTREAM_ERROR',
        message:
          status === 401
            ? 'OpenAI rejected the server API key.'
            : `OpenAI transcription service returned HTTP ${status}. Check the OpenAI project configuration and access, or retry later.`,
        retryable: status >= 500,
        upstreamStatus: status
      });
      expect(responseText).not.toContain(marker);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([...errorLog.mock.calls, ...infoLog.mock.calls])).not.toContain(marker);
      expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toMatchObject({
        event: 'transcription_failed',
        code: 'UPSTREAM_ERROR',
        status: status === 401 ? 503 : 502,
        retryable: status >= 500
      });
    }
  );

  it.each(providerCases)(
    'keeps realtime HTTP %i %s diagnostics out of responses and logs',
    async (status, shape) => {
      const providerBody = JSON.stringify(providerDetails(shape));
      vi.mocked(fetch).mockResolvedValueOnce(new Response(providerBody, { status }));
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});

      const response = await realtimeCall(
        new NextRequest('http://localhost/api/realtime/call', {
          method: 'POST',
          headers: { authorization: credentials },
          body: 'v=0\r\n'
        })
      );
      const responseText = await response.text();
      const responseBody = JSON.parse(responseText) as { error: Record<string, unknown> };

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(status === 401 ? 503 : 502);
      expect(responseBody.error).toEqual({
        code: 'UPSTREAM_ERROR',
        message:
          status === 401
            ? 'OpenAI rejected the server API key.'
            : `Could not establish realtime transcription session. OpenAI returned HTTP ${status}. Verify the OpenAI project has active billing and access to realtime transcription.`,
        retryable: status >= 500,
        upstreamStatus: status
      });
      expect(responseText).not.toContain(marker);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([...errorLog.mock.calls, ...infoLog.mock.calls])).not.toContain(marker);
      expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toMatchObject({
        event: 'realtime_call_failed',
        code: 'UPSTREAM_ERROR',
        status: status === 401 ? 503 : 502,
        retryable: status >= 500,
        upstreamStatus: status
      });
    }
  );

  it('does not expose an invalid realtime status as an upstream status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: `503 ${marker}-status`,
      text: async () => JSON.stringify(providerDetails('nested'))
    } as unknown as Response);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await realtimeCall(
      new NextRequest('http://localhost/api/realtime/call', {
        method: 'POST',
        headers: { authorization: credentials },
        body: 'v=0\r\n'
      })
    );
    const responseText = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: 'UPSTREAM_ERROR',
        message:
          'Could not establish realtime transcription session. Verify the OpenAI project has active billing and access to realtime transcription.',
        retryable: false
      }
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(responseText).not.toContain(marker);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(marker);
  });
});
