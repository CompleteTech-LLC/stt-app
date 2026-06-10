import { getServerConfig } from '@/src/lib/config';
import { AppError } from '@/src/lib/errors';

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export const getClientId = (request: Request) => {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  return forwarded || realIp || 'local';
};

export const assertRateLimit = (request: Request, scope: string) => {
  const { limits } = getServerConfig();
  const key = `${scope}:${getClientId(request)}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limits.rateLimitWindowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > limits.rateLimitMaxRequests) {
    throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', 429, true);
  }
};
