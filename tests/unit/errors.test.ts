import { describe, expect, it } from 'vitest';

import { AppError, toAppError } from '@/src/lib/errors';

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
    const mapped = toAppError(Object.assign(new Error('Unauthorized'), { status: 401 }));

    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.status).toBe(503);
    expect(mapped.message).toBe('OpenAI rejected the server API key.');
  });
});
