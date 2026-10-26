import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

type Env = Record<string, string | undefined>;

type BasicAuthConfig =
  | { mode: 'disabled' | 'invalid' }
  | { mode: 'enabled'; username: string; password: string };

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

export const getBasicAuthConfig = (env: Env = process.env): BasicAuthConfig => {
  const username = env.BASIC_AUTH_USER || '';
  const password = env.BASIC_AUTH_PASSWORD || '';
  if (!username && !password) return { mode: 'disabled' };

  // An incomplete or unusable configuration must never silently disable auth.
  if (
    !username ||
    !password ||
    username.includes(':') ||
    hasControlCharacter(username) ||
    hasControlCharacter(password)
  ) {
    return { mode: 'invalid' };
  }

  return { mode: 'enabled', username, password };
};

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Return only a verified username; never trust an identity supplied in a header. */
export const getAuthenticatedUser = (
  request: Request,
  config = getBasicAuthConfig()
): string | undefined => {
  if (config.mode !== 'enabled') return undefined;

  const authorization = request.headers.get('authorization');
  const encoded = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i)?.[1];
  if (!encoded || encoded.length > 8192 || encoded.length % 4 === 1) return undefined;

  const bytes = Buffer.from(encoded, 'base64');
  // Buffer's base64 decoder is permissive; reject malformed/noncanonical input.
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return undefined;

  let credentials: string;
  try {
    credentials = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }

  // Fixed-size digests allow constant-time comparison even for different lengths.
  return timingSafeEqual(digest(credentials), digest(`${config.username}:${config.password}`))
    ? config.username
    : undefined;
};

/** Used in both Proxy and paid API routes so route calls also fail closed. */
export const basicAuthDenial = (request: Request): Response | undefined => {
  const config = getBasicAuthConfig();
  if (config.mode === 'disabled') return undefined;

  const headers = {
    'Cache-Control': 'private, no-store',
    Vary: 'Authorization'
  };
  if (config.mode === 'invalid') {
    return Response.json(
      { error: 'Application authentication is not configured correctly.' },
      {
        status: 503,
        headers
      }
    );
  }

  if (!getAuthenticatedUser(request, config)) {
    return Response.json(
      { error: 'Authentication required.' },
      {
        status: 401,
        headers: {
          ...headers,
          'WWW-Authenticate': 'Basic realm="Signal STT", charset="UTF-8"'
        }
      }
    );
  }

  // Browsers attach cached Basic credentials automatically. CORS alone does not
  // stop a foreign site sending a simple POST, so reject cross-site mutations.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
    const origin = request.headers.get('origin');
    let foreignOrigin = false;
    if (origin !== null) {
      try {
        const parsed = new URL(origin);
        // Compare Host, not forwarded headers: this also supports TLS terminated
        // by a reverse proxy that preserves Host. Opaque origins fail closed.
        const host = request.headers.get('host') || new URL(request.url).host;
        foreignOrigin = !['http:', 'https:'].includes(parsed.protocol) || parsed.host !== host;
      } catch {
        foreignOrigin = true;
      }
    }
    if (foreignOrigin || request.headers.get('sec-fetch-site') === 'cross-site') {
      return Response.json(
        { error: 'Cross-site requests are not allowed.' },
        {
          status: 403,
          headers
        }
      );
    }
  }
  return undefined;
};
