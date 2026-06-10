import 'server-only';

import { appLimits, sttModels } from './constants';

type Env = Record<string, string | undefined>;

type SttModelConfig = {
  realtime: string;
  fileDefault: string;
  fileHighAccuracy: string;
};

type LimitConfig = {
  maxUploadBytes: number;
  requestTimeoutMs: number;
  realtimeSessionTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export type ServerConfig = {
  openaiApiKey: string | null;
  openaiConfigured: boolean;
  models: SttModelConfig;
  limits: LimitConfig;
  logTranscripts: boolean;
};

export const getServerConfig = (env: Env = process.env): ServerConfig => {
  const openaiApiKey = env.OPENAI_API_KEY?.trim() || null;

  return {
    openaiApiKey,
    openaiConfigured: Boolean(openaiApiKey),
    models: {
      realtime: env.OPENAI_REALTIME_STT_MODEL?.trim() || sttModels.realtime,
      fileDefault: env.OPENAI_FILE_STT_MODEL?.trim() || sttModels.fileDefault,
      fileHighAccuracy:
        env.OPENAI_HIGH_ACCURACY_FILE_STT_MODEL?.trim() || sttModels.fileHighAccuracy
    },
    limits: {
      maxUploadBytes: parsePositiveInt(env.MAX_UPLOAD_BYTES, appLimits.maxUploadBytes),
      requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_MS, appLimits.requestTimeoutMs),
      realtimeSessionTimeoutMs: parsePositiveInt(
        env.REALTIME_SESSION_TIMEOUT_MS,
        appLimits.realtimeSessionTimeoutMs
      ),
      rateLimitWindowMs: parsePositiveInt(env.RATE_LIMIT_WINDOW_MS, appLimits.rateLimitWindowMs),
      rateLimitMaxRequests: parsePositiveInt(
        env.RATE_LIMIT_MAX_REQUESTS,
        appLimits.rateLimitMaxRequests
      )
    },
    logTranscripts: env.LOG_TRANSCRIPTS === 'true' && env.NODE_ENV !== 'production'
  };
};

export const requireOpenAIKey = (config = getServerConfig()) => {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is missing');
  }

  return config.openaiApiKey;
};
