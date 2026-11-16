import { ZodError } from 'zod';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'CONFIGURATION_ERROR'
  | 'INVALID_FILE'
  | 'MISSING_API_KEY'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'UNKNOWN_ERROR';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 500,
    public readonly retryable = false,
    public readonly upstreamStatus?: number,
    public readonly upstreamCode?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const getUpstreamStatus = (status: unknown): number | undefined =>
  typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;

export const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError('BAD_REQUEST', error.issues[0]?.message || 'Invalid request.', 400);
  }

  if (error instanceof Error) {
    const upstreamStatus = getUpstreamStatus((error as { status?: unknown }).status);
    if (
      upstreamStatus !== 401 &&
      (error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        error.name === 'APIConnectionTimeoutError' ||
        error.message.toLowerCase().includes('timeout') ||
        /\btimed[\s-]+out\b/i.test(error.message))
    ) {
      return new AppError(
        'TIMEOUT',
        'The transcription request timed out. Try a shorter file.',
        504,
        true
      );
    }

    if (error.message === 'OPENAI_API_KEY is missing') {
      return new AppError(
        'MISSING_API_KEY',
        'OpenAI API key is not configured on the server.',
        503
      );
    }

    if (upstreamStatus !== undefined && upstreamStatus >= 400) {
      return new AppError(
        'UPSTREAM_ERROR',
        upstreamStatus === 401
          ? 'OpenAI rejected the server API key.'
          : `OpenAI transcription service returned HTTP ${upstreamStatus}. Check the OpenAI project configuration and access, or retry later.`,
        upstreamStatus === 401 ? 503 : 502,
        upstreamStatus >= 500,
        upstreamStatus
      );
    }
  }

  return new AppError('UNKNOWN_ERROR', 'Unexpected server error.', 500);
};

export const errorResponseBody = (error: AppError) => ({
  error: {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    upstreamStatus: error.upstreamStatus,
    upstreamCode: error.upstreamCode
  }
});
