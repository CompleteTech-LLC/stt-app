import 'server-only';

import { getServerConfig, requireOpenAIKey } from '@/src/lib/config';
import { AppError, getUpstreamStatus } from '@/src/lib/errors';

type RealtimeInput = {
  language: string;
  delay: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  safetyIdentifier?: string;
  signal?: AbortSignal;
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
    const signal = input.signal
      ? AbortSignal.any([controller.signal, input.signal])
      : controller.signal;
    signal.throwIfAborted();
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(input.safetyIdentifier ? { 'OpenAI-Safety-Identifier': input.safetyIdentifier } : {})
      },
      body: form,
      signal
    });

    const body = await response.text();

    if (!response.ok) {
      const upstreamStatus = getUpstreamStatus(response.status);
      throw new AppError(
        'UPSTREAM_ERROR',
        upstreamStatus === 401
          ? 'OpenAI rejected the server API key.'
          : upstreamStatus === undefined
            ? 'Could not establish realtime transcription session. Verify the OpenAI project has active billing and access to realtime transcription.'
            : `Could not establish realtime transcription session. OpenAI returned HTTP ${upstreamStatus}. Verify the OpenAI project has active billing and access to realtime transcription.`,
        upstreamStatus === 401 ? 503 : 502,
        upstreamStatus !== undefined && upstreamStatus >= 500,
        upstreamStatus
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
