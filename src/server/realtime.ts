import 'server-only';

import { getServerConfig, requireOpenAIKey } from '@/src/lib/config';
import { AppError } from '@/src/lib/errors';

type RealtimeInput = {
  language: string;
  delay: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  safetyIdentifier?: string;
};

type RealtimeClientSecretResponse = {
  value?: string;
  client_secret?: {
    value?: string;
  };
  expires_at?: number;
};

const parseOpenAIError = (body: string): { message?: string; code?: string } => {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        code?: string;
        type?: string;
      };
    };

    return {
      message: parsed.error?.message,
      code: parsed.error?.code || parsed.error?.type
    };
  } catch {
    return {};
  }
};

export const createRealtimeClientSecret = async (input: RealtimeInput) => {
  const config = getServerConfig();
  const apiKey = requireOpenAIKey(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.limits.realtimeSessionTimeoutMs);

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(input.safetyIdentifier ? { 'OpenAI-Safety-Identifier': input.safetyIdentifier } : {})
      },
      body: JSON.stringify({
        session: {
          type: 'transcription',
          audio: {
            input: {
              transcription: {
                model: config.models.realtime,
                language: input.language === 'auto' ? undefined : input.language,
                delay: input.delay
              },
              turn_detection: null
            }
          }
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new AppError(
        'UPSTREAM_ERROR',
        response.status === 401
          ? 'OpenAI rejected the server API key.'
          : 'Could not create realtime transcription session.',
        response.status === 401 ? 503 : 502,
        response.status >= 500
      );
    }

    const data = (await response.json()) as RealtimeClientSecretResponse;
    const value = data.client_secret?.value || data.value;

    if (!value) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'Realtime session response did not include a client secret.',
        502
      );
    }

    return {
      clientSecret: value,
      expiresAt: data.expires_at ?? null,
      model: config.models.realtime
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const createRealtimeCallAnswer = async (input: RealtimeInput & { sdp: string }) => {
  const config = getServerConfig();
  const apiKey = requireOpenAIKey(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.limits.realtimeSessionTimeoutMs);
  const form = new FormData();

  form.set('sdp', input.sdp);
  form.set(
    'session',
    JSON.stringify({
      type: 'transcription',
      audio: {
        input: {
          transcription: {
            model: config.models.realtime,
            language: input.language === 'auto' ? undefined : input.language,
            delay: input.delay
          },
          turn_detection: null
        }
      }
    })
  );

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(input.safetyIdentifier ? { 'OpenAI-Safety-Identifier': input.safetyIdentifier } : {})
      },
      body: form,
      signal: controller.signal
    });

    const body = await response.text();

    if (!response.ok) {
      const upstream = parseOpenAIError(body);
      throw new AppError(
        'UPSTREAM_ERROR',
        response.status === 401
          ? 'OpenAI rejected the server API key.'
          : `Could not establish realtime transcription session. OpenAI returned HTTP ${
              response.status
            }${upstream.message ? `: ${upstream.message}` : '.'}`,
        response.status === 401 ? 503 : 502,
        response.status >= 500,
        response.status,
        upstream.code
      );
    }

    if (!body.trim().startsWith('v=')) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'Realtime response did not include a valid SDP answer.',
        502
      );
    }

    return {
      sdp: body,
      model: config.models.realtime
    };
  } finally {
    clearTimeout(timeout);
  }
};
