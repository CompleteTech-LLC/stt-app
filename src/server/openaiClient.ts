import 'server-only';

import OpenAI from 'openai';

import { getServerConfig, requireOpenAIKey } from '@/src/lib/config';

export const createOpenAIClient = (config = getServerConfig()) =>
  new OpenAI({
    apiKey: requireOpenAIKey(config),
    timeout: config.limits.requestTimeoutMs,
    maxRetries: 1
  });
