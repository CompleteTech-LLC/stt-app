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

const getString = (value: unknown) => (typeof value === 'string' ? value : undefined);

const getOpenAIErrorDetails = (error: Error) => {
  const candidate = error as {
    status?: number;
    code?: string;
    type?: string;
    error?: {
      code?: string;
      type?: string;
      message?: string;
    };
  };

  return {
    status: candidate.status,
    code: candidate.code || candidate.type || candidate.error?.code || candidate.error?.type,
    message: getString(candidate.error?.message) || getString(error.message)
  };
};

export const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError('BAD_REQUEST', error.issues[0]?.message || 'Invalid request.', 400);
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.message.toLowerCase().includes('timeout')) {
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

    const upstream = getOpenAIErrorDetails(error);
    const maybeStatus = upstream.status;
    if (maybeStatus && maybeStatus >= 400) {
      return new AppError(
        'UPSTREAM_ERROR',
        maybeStatus === 401
          ? 'OpenAI rejected the server API key.'
          : upstream.message
            ? `OpenAI transcription service returned HTTP ${maybeStatus}: ${upstream.message}`
            : `OpenAI transcription service returned HTTP ${maybeStatus}.`,
        maybeStatus === 401 ? 503 : 502,
        maybeStatus >= 500,
        maybeStatus,
        upstream.code
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
