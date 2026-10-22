import { createHash, randomBytes } from 'node:crypto';

import { getServerConfig } from '@/src/lib/config';
import { AppError } from '@/src/lib/errors';

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

/**
 * Bucket key used when no trustworthy per-client address is available. Next.js
 * route handlers do not expose the socket address, and client-supplied
 * forwarding headers cannot be trusted unless a known reverse proxy sets them.
 * Without TRUST_PROXY=true every caller therefore shares one rate-limit bucket,
 * which cannot be bypassed by spoofing headers.
 */
export const SHARED_CLIENT_ID = 'shared';

type ClientIdOptions = {
  trustProxy?: boolean;
};

export const getClientId = (
  request: Request,
  { trustProxy = getServerConfig().trustProxy }: ClientIdOptions = {}
) => {
  if (!trustProxy) return SHARED_CLIENT_ID;

  // A trusted reverse proxy appends the address it saw to X-Forwarded-For, so
  // the right-most entry is the one the proxy vouches for. Entries to its left
  // are client-supplied and can be forged.
  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  const realIp = request.headers.get('x-real-ip')?.trim();
  return forwarded || realIp || SHARED_CLIENT_ID;
};

const processSalt = randomBytes(32).toString('hex');

/**
 * Returns a pseudonymous identifier suitable for the provider's
 * OpenAI-Safety-Identifier header: a salted SHA-256 hash of the client id, so
 * the raw caller IP is never sent upstream. Returns undefined when the client
 * cannot be distinguished (shared bucket), since a constant id is meaningless.
 */
export const getSafetyIdentifier = (
  request: Request,
  {
    trustProxy = getServerConfig().trustProxy,
    salt = getServerConfig().safetyIdentifierSalt ?? processSalt
  }: ClientIdOptions & { salt?: string } = {}
) => {
  const clientId = getClientId(request, { trustProxy });
  if (clientId === SHARED_CLIENT_ID) return undefined;
  return createHash('sha256').update(`${salt}:${clientId}`).digest('hex').slice(0, 32);
};

export const assertRateLimit = (request: Request, scope: string) => {
  const config = getServerConfig();
  const { limits } = config;
  const key = `${scope}:${getClientId(request, { trustProxy: config.trustProxy })}`;
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

/** Test helper: clears all in-memory rate-limit buckets. */
export const resetRateLimits = () => buckets.clear();
