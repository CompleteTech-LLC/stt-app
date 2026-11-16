import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';

import { AppError, errorResponseBody, toAppError } from '@/src/lib/errors';

describe('error mapping', () => {
  it('preserves structured app errors', () => {
    const error = new AppError('INVALID_FILE', 'Bad file', 415);

    expect(toAppError(error)).toBe(error);
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
