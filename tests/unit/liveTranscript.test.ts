import { describe, expect, it } from 'vitest';

import { LiveUtterances, appendRealtimeDelta, joinTranscriptText } from '@/src/lib/liveTranscript';

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

describe('ordered live utterances', () => {
  it('reorders an existing item and its descendants when predecessor metadata arrives', () => {
    const items = new LiveUtterances();
    items.register('B');
    items.register('C', 'B');
    items.register('A');
    items.register('B', 'A');
    items.update('A', 'partial', 'first');
    items.update('B', 'partial', 'second');
    items.update('C', 'partial', 'third');
    expect(items.preview()).toBe('first second third');
    expect(items.update('C', 'final', 'third')).toBe('');
    expect(items.update('B', 'final', 'second')).toBe('');
    expect(items.update('A', 'final', 'first')).toBe('first second third');
  });

  it('retains a non-audio item’s predecessor until the chain resolves', () => {
    const items = new LiveUtterances();
    items.register('A');
    items.skip('X', 'A');
    items.register('B', 'X');
    expect(items.update('B', 'final', 'second')).toBe('');
    expect(items.update('A', 'final', 'first')).toBe('first second');
  });

  it('deduplicates a discarded anonymous final before allowing a new anonymous item', () => {
    const items = new LiveUtterances();
    items.update(undefined, 'partial', 'deleted');
    items.discard();
    expect(items.update(undefined, 'final', 'deleted', 'final-event')).toBe('');
    expect(items.update(undefined, 'final', 'deleted', 'final-event')).toBe('');
    expect(items.update(undefined, 'final', 'new', 'new-event')).toBe('new');
  });

  it('holds a final whose known predecessor has not registered yet', () => {
    const items = new LiveUtterances();
    items.register('B', 'A');
    expect(items.update('B', 'final', 'second')).toBe('');
    items.register('A');
    expect(items.update('A', 'final', 'first')).toBe('first second');
  });

  it('unblocks a final when its predecessor is identified as non-audio', () => {
    const items = new LiveUtterances();
    items.register('B', 'A');
    expect(items.update('B', 'final', 'speech')).toBe('');
    expect(items.skip('A')).toBe('speech');
  });

  it('deduplicates identified events but preserves equal unidentified deltas', () => {
    const items = new LiveUtterances();
    items.update('A', 'partial', 'ha', 'event-1');
    items.update('A', 'partial', 'ha', 'event-1');
    items.update('A', 'partial', 'ha', 'event-2');
    items.update('A', 'partial', 'ha');
    items.update('A', 'partial', 'ha');
    expect(items.preview()).toBe('hahahaha');
    expect(items.update('A', 'final', 'corrected')).toBe('corrected');
  });

  it('inserts a late-registered predecessor before its successor and retains both drafts', () => {
    const items = new LiveUtterances();
    items.register('B', 'A');
    items.update('B', 'partial', 'second draft');
    items.register('A');
    items.update('A', 'partial', 'first draft');
    expect(items.preview()).toBe('first draft second draft');
    expect(items.update('B', 'final', 'second final')).toBe('');
    expect(items.update('A', 'final', 'first final')).toBe('first final second final');
  });

  it('does not append a repeated completion after an item has been committed', () => {
    const items = new LiveUtterances();
    expect(items.update('A', 'final', 'first')).toBe('first');
    expect(items.update('A', 'final', 'first')).toBe('');
    expect(items.update('B', 'final', 'second')).toBe('second');
  });

  it('ignores late registration and deltas for committed and empty items', () => {
    const items = new LiveUtterances();
    expect(items.update('A', 'final', '')).toBe('');
    items.register('A');
    expect(items.update('A', 'partial', 'late')).toBe('');
    expect(items.preview()).toBe('');
    expect(items.update('A', 'final', 'late')).toBe('');
    expect(items.update('B', 'final', 'next')).toBe('next');
  });

  it('bounds remembered resolved IDs while retaining recent committed and discarded IDs', () => {
    const items = new LiveUtterances();
    items.update('old', 'final', 'old');
    for (let i = 0; i < 1023; i++) items.update(`item-${i}`, 'final', 'text');
    items.register('discarded');
    items.discard();
    expect(items.update('discarded', 'final', 'late')).toBe('');
    expect(items.update('item-1022', 'final', 'late')).toBe('');
    expect(items.update('old', 'final', 'reused after eviction')).toBe('reused after eviction');
  });

  it('clears all overlapping items, even when one has completed out of order', () => {
    const items = new LiveUtterances();
    items.update('A', 'partial', 'first draft');
    items.update('B', 'partial', 'second draft');
    items.update('B', 'final', 'second final');
    items.discard();
    expect(items.update('B', 'final', 'second final')).toBe('');
    expect(items.update('A', 'final', 'first final')).toBe('');
    expect(items.update('C', 'final', 'new')).toBe('new');
    expect(items.finish()).toBe('');
  });
  it('discards only the cleared item when another completes first', () => {
    const items = new LiveUtterances();
    items.update('A', 'partial', 'old');
    items.discard();
    expect(items.update('B', 'final', 'new')).toBe('new');
    expect(items.update('A', 'final', 'old final')).toBe('');
  });

  it('keeps overlapping drafts in item order, including a later final arriving first', () => {
    const items = new LiveUtterances();
    items.register('A');
    items.register('B', 'A');
    items.update('A', 'partial', 'first');
    items.update('B', 'partial', 'second draft');
    expect(items.update('B', 'final', 'second final')).toBe('');
    expect(items.preview()).toBe('first second final');
    expect(items.update('A', 'final', 'first final')).toBe('first final second final');
    expect(items.finish()).toBe('');
  });

  it('retains a later draft when an earlier final arrives and stop flushes it', () => {
    const items = new LiveUtterances();
    items.update('A', 'partial', 'first');
    items.update('B', 'partial', 'second');
    expect(items.update('A', 'final', 'first final')).toBe('first final');
    expect(items.finish()).toBe('second');
  });

  it('discards registered items even before their first delta, including empty finals', () => {
    const items = new LiveUtterances();
    items.register('A');
    items.discard();
    expect(items.update('A', 'final', '')).toBe('');
    expect(items.update('B', 'final', 'new')).toBe('new');
    expect(items.update('A', 'final', 'late')).toBe('');
  });

  it('handles empty completions and malformed IDs without throwing or discarding later anonymous items', () => {
    const items = new LiveUtterances();
    items.update(null, 'partial', 'old');
    items.discard();
    expect(items.update({ bad: true }, 'final', '')).toBe('');
    expect(items.update(undefined, 'final', 'next')).toBe('next');
    expect(items.update('', 'final', '')).toBe('');
    expect(items.update(42, 'final', 'after empty')).toBe('after empty');
  });
});
