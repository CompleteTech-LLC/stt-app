// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as transcribe } from '@/app/api/transcribe/route';
import { POST as realtimeCall } from '@/app/api/realtime/call/route';
import { transcribeFile } from '@/src/server/fileTranscription';
import { createRealtimeCallAnswer } from '@/src/server/realtime';
import { resetRateLimits } from '@/src/server/rateLimit';

vi.mock('@/src/server/fileTranscription', () => ({ transcribeFile: vi.fn() }));
vi.mock('@/src/server/realtime', () => ({ createRealtimeCallAnswer: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetRateLimits();
});

describe('paid route authentication', () => {
  it.each([
    ['transcribe', transcribe],
    ['realtime/call', realtimeCall]
  ] as const)(
    'denies direct %s route calls before reading the body or contacting OpenAI',
    async (path, handler) => {
      vi.stubEnv('BASIC_AUTH_USER', 'operator');
      vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
      const request = new NextRequest(`http://localhost/api/${path}`, { method: 'POST' });
      const readForm = vi.spyOn(request, 'formData');
      const readText = vi.spyOn(request, 'text');
      const response = await handler(request);
      expect(response.status).toBe(401);
      expect(readForm).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(createRealtimeCallAnswer).not.toHaveBeenCalled();
    }
  );

  it('lets valid credentials reach realtime processing with a hashed account id', async () => {
    vi.stubEnv('BASIC_AUTH_USER', 'operator');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'test-password');
    vi.mocked(createRealtimeCallAnswer).mockResolvedValue({ sdp: 'v=0\r\n', model: 'test-model' });
    const response = await realtimeCall(
      new NextRequest('http://localhost/api/realtime/call', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from('operator:test-password').toString('base64')}`
        },
        body: 'v=0\r\n'
      })
    );
    expect(response.status).toBe(200);
    expect(createRealtimeCallAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        safetyIdentifier: expect.stringMatching(/^[0-9a-f]{32}$/)
      })
    );
  });
});
