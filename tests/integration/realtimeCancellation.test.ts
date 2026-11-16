// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRealtimeCallAnswer } from '@/src/server/realtime';

const input = { sdp: 'v=0\r\n', language: 'en', delay: 'low' as const };

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function holdUpstreamUntilAbort() {
  let upstreamSignal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation((_url, options) => {
    upstreamSignal = options?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      upstreamSignal!.addEventListener('abort', () => reject(upstreamSignal!.reason), {
        once: true
      });
    });
  });
  return () => upstreamSignal;
}

describe('realtime request cancellation', () => {
  it('still accepts a valid answer without a client signal and clears its timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('OPENAI_REALTIME_STT_MODEL', 'synthetic-model');
    vi.mocked(fetch).mockResolvedValue(new Response('v=0\r\n'));

    await expect(createRealtimeCallAnswer(input)).resolves.toEqual({
      sdp: 'v=0\r\n',
      model: 'synthetic-model'
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create an upstream call when the client already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createRealtimeCallAnswer({ ...input, signal: controller.signal })
    ).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates client cancellation while the upstream request is pending', async () => {
    const controller = new AbortController();
    const getSignal = holdUpstreamUntilAbort();
    const request = createRealtimeCallAnswer({ ...input, signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    expect(getSignal()?.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(getSignal()?.aborted).toBe(true);
  });

  it('retains the server timeout when a client signal is also present', async () => {
    vi.useFakeTimers();
    vi.stubEnv('REALTIME_SESSION_TIMEOUT_MS', '25');
    const controller = new AbortController();
    const getSignal = holdUpstreamUntilAbort();
    const request = createRealtimeCallAnswer({ ...input, signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(getSignal()?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });
});
