import { describe, expect, it } from 'vitest';

import { appendRealtimeDelta, joinTranscriptText } from '@/src/lib/liveTranscript';

describe('live transcript helpers', () => {
  it('accumulates realtime word deltas for the workspace preview', () => {
    const draft = ['Hello', ' ', 'world'].reduce(appendRealtimeDelta, '');

    expect(draft).toBe('Hello world');
    expect(joinTranscriptText('', draft)).toBe('Hello world');
  });

  it('previews live draft after existing finalized transcript text', () => {
    expect(joinTranscriptText('First sentence.', 'Next')).toBe('First sentence. Next');
    expect(joinTranscriptText('First sentence. ', 'Next')).toBe('First sentence. Next');
  });
});
