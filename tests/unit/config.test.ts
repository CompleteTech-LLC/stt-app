import { describe, expect, it } from 'vitest';

import { getServerConfig } from '@/src/lib/config';
import { appLimits, sttModels } from '@/src/lib/constants';

describe('server config', () => {
  it('uses secure defaults and reports missing API key', () => {
    const config = getServerConfig({});

    expect(config.openaiApiKey).toBeNull();
    expect(config.openaiConfigured).toBe(false);
    expect(config.models.fileDefault).toBe(sttModels.fileDefault);
    expect(config.models.fileHighAccuracy).toBe(sttModels.fileHighAccuracy);
    expect(config.models.realtime).toBe(sttModels.realtime);
    expect(config.limits.maxUploadBytes).toBe(appLimits.maxUploadBytes);
  });

  it('supports centralized model and limit overrides', () => {
    const config = getServerConfig({
      OPENAI_API_KEY: 'sk-test-secret-value-not-real',
      OPENAI_FILE_STT_MODEL: 'gpt-4o-transcribe',
      OPENAI_HIGH_ACCURACY_FILE_STT_MODEL: 'gpt-4o-transcribe',
      OPENAI_REALTIME_STT_MODEL: 'gpt-realtime-whisper',
      MAX_UPLOAD_BYTES: '1024',
      RATE_LIMIT_MAX_REQUESTS: '2'
    });

    expect(config.openaiConfigured).toBe(true);
    expect(config.models.fileDefault).toBe('gpt-4o-transcribe');
    expect(config.limits.maxUploadBytes).toBe(1024);
    expect(config.limits.rateLimitMaxRequests).toBe(2);
  });
});
