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
    expect(joinTranscriptText('  Indented\nline\n', 'speech')).toBe('  Indented\nline\nspeech');
  });
});

describe('ordered live utterances', () => {
  it('reorders an existing item and its descendants when predecessor metadata arrives', () => {
    const items = new LiveUtterances();
    items.register('B');
    items.register('C', 'B');
    items.register('A', null);
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
    items.register('A', null);
    items.skip('X', 'A');
    items.register('B', 'X');
    expect(items.update('B', 'final', 'second')).toBe('');
    expect(items.update('A', 'final', 'first')).toBe('first second');
  });

  it('rejects anonymous events without treating event IDs as utterance IDs', () => {
    const items = new LiveUtterances();
    items.update(undefined, 'partial', 'deleted');
    expect(items.error).toMatch(/item ID.*Stop and Start/);
    items.discard();
    expect(items.update(undefined, 'final', 'deleted', 'final-event')).toBe('');
    expect(items.update(undefined, 'final', 'deleted', 'final-event')).toBe('');
    expect(items.update(undefined, 'final', 'new', 'new-event')).toBe('');
    expect(items.preview()).toBe('');
  });

  it('holds a final whose known predecessor has not registered yet', () => {
    const items = new LiveUtterances();
    items.register('B', 'A');
    expect(items.update('B', 'final', 'second')).toBe('');
    items.register('A', null);
    expect(items.update('A', 'final', 'first')).toBe('first second');
  });

  it('unblocks a final when its predecessor is identified as non-audio', () => {
    const items = new LiveUtterances();
    items.register('B', 'A');
    expect(items.update('B', 'final', 'speech')).toBe('');
    expect(items.skip('A', null)).toBe('speech');
  });

  it('deduplicates identified events but preserves equal unidentified deltas', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.update('A', 'partial', 'ha', 'event-1');
    items.update('A', 'partial', 'ha', 'event-1');
    items.update('A', 'partial', 'ha', 'event-2');
    items.update('A', 'partial', 'ha');
    items.update('A', 'partial', 'ha');
    expect(items.preview()).toBe('hahahaha');
    expect(items.update('A', 'final', 'corrected')).toBe('corrected');
  });

  it.each(['missing', 'different-item', 'different-text', 'failed'] as const)(
    'refuses %s identity or content with a reused event ID',
    (variant) => {
      const items = new LiveUtterances();
      items.update('A', 'partial', 'saved', 'same-event');
      if (variant === 'missing') items.update(undefined, 'final', 'saved', 'same-event');
      if (variant === 'different-item') items.update('B', 'partial', 'saved', 'same-event');
      if (variant === 'different-text') items.update('A', 'partial', 'changed', 'same-event');
      if (variant === 'failed') items.fail(undefined, undefined, 'same-event');
      expect(items.error).toMatch(/item ID|event ID.*reused/);
      expect(items.preview()).toBe('saved');
      expect(items.update('B', 'final', 'not accepted')).toBe('');
    }
  );

  it('retains unordered finals until late predecessor metadata establishes their order', () => {
    const items = new LiveUtterances();
    expect(items.update('B', 'final', 'second')).toBe('');
    expect(items.update('A', 'final', 'first')).toBe('');
    expect(items.orderUncertain).toBe(true);
    items.register('B', 'A');
    expect(items.preview()).toBe('first second');
    expect(items.register('A', null)).toBe('first second');
    expect(items.orderUncertain).toBe(false);
    expect(items.error).toBe('');

    const unknown = new LiveUtterances();
    unknown.update('B', 'final', 'second');
    unknown.update('A', 'final', 'first');
    expect(unknown.finish()).toBe(
      '[Live item; order unconfirmed]\nsecond\n\n[Live item; order unconfirmed]\nfirst'
    );
  });

  it('orders an explicit first item before pending items with unknown predecessors', () => {
    const items = new LiveUtterances();
    items.update('B', 'partial', 'second');
    items.register('A', null);
    items.register('B', 'A');
    items.update('A', 'partial', 'first');
    expect(items.preview()).toBe('first second');
    expect(items.update('B', 'final', 'second')).toBe('');
    expect(items.update('A', 'final', 'first')).toBe('first second');
    expect(items.error).toBe('');
  });

  it('fences contradictory or duplicate explicit first-item metadata', () => {
    const late = new LiveUtterances();
    expect(late.update('A', 'final', 'later', undefined, null)).toBe('later');
    late.update('B', 'partial', 'first');
    late.register('B', null);
    expect(late.error).toMatch(/multiple items.*first/);
    expect(late.finish()).toContain('first');

    const committed = new LiveUtterances();
    committed.update('A', 'final', 'later', undefined, null);
    committed.update('B', 'final', 'first');
    committed.register('B', null);
    expect(committed.error).toMatch(/multiple items.*first/);

    const duplicate = new LiveUtterances();
    duplicate.register('A', null);
    duplicate.update('A', 'partial', 'saved');
    duplicate.register('B', null);
    expect(duplicate.error).toMatch(/multiple items.*first/);
    expect(duplicate.preview()).toBe('saved');

    const consistent = new LiveUtterances();
    consistent.update('A', 'final', 'first');
    consistent.register('A', null);
    expect(consistent.update('B', 'final', 'second', undefined, 'A')).toBe('second');
    expect(consistent.error).toBe('');
  });

  it('does not apply predecessor metadata from a conflicting duplicate event', () => {
    const items = new LiveUtterances();
    items.update('A', 'partial', 'first', 'event');
    items.update('B', 'partial', 'second');
    expect(items.preview()).toBe('first second');
    items.update('A', 'partial', 'first', 'event', 'B');
    expect(items.error).toMatch(/event ID.*reused/);
    expect(items.preview()).toBe('first second');
  });

  it('inserts a late-registered predecessor before its successor and retains both drafts', () => {
    const items = new LiveUtterances();
    items.register('B', 'A');
    items.update('B', 'partial', 'second draft');
    items.register('A', null);
    items.update('A', 'partial', 'first draft');
    expect(items.preview()).toBe('first draft second draft');
    expect(items.update('B', 'final', 'second final')).toBe('');
    expect(items.update('A', 'final', 'first final')).toBe('first final second final');
  });

  it('does not append a repeated completion after an item has been committed', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.register('B', 'A');
    expect(items.update('A', 'final', 'first')).toBe('first');
    expect(items.update('A', 'final', 'first')).toBe('');
    expect(items.update('B', 'final', 'second')).toBe('second');
  });

  it('fences late conflicting deltas for committed and empty items', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    expect(items.update('A', 'final', '')).toBe('');
    items.register('A');
    expect(items.update('A', 'partial', 'late')).toBe('');
    expect(items.preview()).toBe('');
    expect(items.update('A', 'final', 'late')).toBe('');
    expect(items.error).toMatch(/terminal item.*conflicting/);
    expect(items.update('B', 'final', 'next')).toBe('');
    expect(new LiveUtterances().update('B', 'final', 'next', undefined, null)).toBe('next');
  });

  it('keeps direct predecessor chains adjacent without interposing another draft', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.register('X', 'B');
    items.update('A', 'partial', 'first');
    items.update('X', 'partial', 'other');
    items.register('B', 'A');
    items.update('X', 'final', 'other');
    items.update('B', 'final', 'second');
    expect(items.preview()).toBe('first second other');
    expect(items.update('A', 'final', 'first')).toBe('first second other');
    items.register('B', 'A');
    expect(items.error).toBe('');
  });

  it('rejects conflicting successors or already-impossible predecessor order', () => {
    const siblings = new LiveUtterances();
    siblings.register('B', 'A');
    siblings.update('B', 'partial', 'saved');
    siblings.register('C', 'A');
    expect(siblings.error).toMatch(/same predecessor/);
    expect(siblings.preview()).toBe('saved');

    const late = new LiveUtterances();
    late.update('A', 'final', 'first', undefined, null);
    late.update('X', 'final', 'other', undefined, 'A');
    late.register('B', 'A');
    expect(late.error).toMatch(/committed item order/);
    expect(late.update('B', 'final', 'second')).toBe('');
  });

  it('fences conflicting terminal events but deduplicates exact final text', () => {
    const pending = new LiveUtterances();
    pending.register('A', null);
    pending.update('A', 'partial', 'first');
    pending.register('B', 'A');
    pending.update('B', 'final', 'second', 'event-1');
    pending.update('B', 'final', 'different', 'event-2');
    expect(pending.error).toMatch(/terminal item.*conflicting/);
    expect(pending.finish()).toBe('first second');

    const resolved = new LiveUtterances();
    resolved.register('A', null);
    expect(resolved.update('A', 'final', 'first', 'event-1')).toBe('first');
    expect(resolved.update('A', 'final', 'first', 'event-2')).toBe('');
    expect(resolved.error).toBe('');
    expect(resolved.update('A', 'final', 'different', 'event-3')).toBe('');
    expect(resolved.error).toMatch(/terminal item.*conflicting/);

    const failure = new LiveUtterances();
    failure.update('A', 'final', 'first');
    failure.fail('A');
    expect(failure.error).toMatch(/terminal item.*conflicting/);
  });

  it('fences the session instead of evicting resolved IDs at the item limit', () => {
    const items = new LiveUtterances();
    items.update('old', 'final', 'old', undefined, null);
    for (let index = 0; index < 1023; index++) {
      items.update(
        `item-${index}`,
        'final',
        'text',
        undefined,
        index ? `item-${index - 1}` : 'old'
      );
    }
    items.register('discarded');
    expect(items.error).toMatch(/item limit/);
    items.discard();
    expect(items.update('discarded', 'final', 'late')).toBe('');
    expect(items.update('item-1022', 'final', 'late')).toBe('');
    expect(items.update('old', 'final', 'reused after eviction')).toBe('');
  });

  it('clears all overlapping items, even when one has completed out of order', () => {
    const items = new LiveUtterances();
    items.update('A', 'partial', 'first draft');
    items.update('B', 'partial', 'second draft');
    items.update('B', 'final', 'second final');
    items.discard();
    expect(items.update('B', 'final', 'second final')).toBe('');
    expect(items.update('A', 'final', 'first final')).toBe('');
    expect(items.update('C', 'final', 'new')).toBe('');
    expect(items.error).toMatch(/workspace changed/);
    expect(items.finish()).toBe('');
  });
  it('fences both new and old IDs after discard until a new session', () => {
    const items = new LiveUtterances();
    items.update('A', 'partial', 'old');
    items.discard();
    expect(items.update('B', 'final', 'new')).toBe('');
    expect(items.update('A', 'final', 'old final')).toBe('');
    expect(new LiveUtterances().update('B', 'final', 'new', undefined, null)).toBe('new');
  });

  it('keeps overlapping drafts in item order, including a later final arriving first', () => {
    const items = new LiveUtterances();
    items.register('A', null);
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
    items.register('A', null);
    items.register('B', 'A');
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
    expect(items.update('B', 'final', 'new')).toBe('');
    expect(items.update('A', 'final', 'late')).toBe('');
    expect(items.error).toMatch(/workspace changed/);
  });

  it.each([null, { bad: true }, undefined, '', 42])(
    'rejects malformed item ID %s without guessing a new identity',
    (id) => {
      const items = new LiveUtterances();
      expect(items.update(id, 'final', '')).toBe('');
      expect(items.error).toMatch(/item ID/);
      expect(items.update('B', 'final', 'next')).toBe('');
      expect(items.preview()).toBe('');
    }
  );

  it('preserves identified drafts when an anonymous completion creates ambiguity', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.update('A', 'partial', 'old');
    expect(items.update(undefined, 'final', 'new', 'different-event')).toBe('');
    expect(items.error).toMatch(/item ID/);
    expect(items.preview()).toBe('old');
    expect(items.update('A', 'final', 'old final')).toBe('');
    expect(items.finish()).toBe('old');
  });

  it('fences known and subsequently described unregistered predecessors on discard', () => {
    const items = new LiveUtterances();
    items.register('B', 'A');
    items.register('C', 'B');
    items.update('B', 'partial', 'second');
    items.update('C', 'partial', 'third');
    items.discard();
    items.register('A', 'older');
    expect(items.update('older', 'final', 'older')).toBe('');
    expect(items.update('A', 'final', 'first')).toBe('');
    expect(items.update('new', 'final', 'ambiguous')).toBe('');
    expect(items.preview()).toBe('');
    expect(items.error).toMatch(/workspace changed/);
  });

  it('fences a backlog larger than 1024 without resurrecting its first item', () => {
    const items = new LiveUtterances();
    for (let index = 0; index < 1025; index++) items.register(`item-${index}`);
    expect(items.error).toMatch(/item limit/);
    items.discard();
    expect(items.update('item-0', 'final', 'old')).toBe('');
    expect(items.update('item-1024', 'final', 'also old')).toBe('');
    expect(items.update('new', 'final', 'ambiguous')).toBe('');
    expect(items.preview()).toBe('');
  });

  it('fences contradictory non-audio identity for pending and resolved audio', () => {
    const items = new LiveUtterances();
    items.register('A', undefined, true);
    items.update('A', 'partial', 'spoken');
    items.skip('A');
    expect(items.preview()).toBe('spoken');
    expect(items.error).toMatch(/non-audio.*conflicts/);
    expect(items.update('A', 'final', 'spoken final')).toBe('');
    const resolved = new LiveUtterances();
    resolved.update('A', 'final', 'spoken', undefined, null);
    resolved.skip('A');
    expect(resolved.error).toMatch(/non-audio.*conflicts/);
    const reverse = new LiveUtterances();
    reverse.skip('A', null);
    reverse.update('A', 'final', 'spoken');
    expect(reverse.error).toMatch(/conflicting/);
  });

  it('resolves a failed predecessor and keeps its partial text before successors', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.update('A', 'partial', 'incomplete');
    items.register('B', 'A');
    expect(items.update('B', 'final', 'second')).toBe('');
    expect(items.fail('A', undefined, 'failure')).toBe('incomplete second');
    expect(items.fail('A', undefined, 'failure')).toBe('');
    expect(items.update('C', 'final', 'third', undefined, 'B')).toBe('third');
  });

  it('stops on an event limit without erasing pending text', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.update('A', 'partial', 'saved', 'event-0');
    for (let index = 1; index < 4096; index++) items.update('A', 'partial', '', `event-${index}`);
    expect(items.update('A', 'partial', 'refused', 'event-4096')).toBe('');
    expect(items.error).toMatch(/event limit/);
    expect(items.finish()).toBe('saved');
  });

  it('stops on a pending-text limit without erasing the existing draft', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    const draft = 'x'.repeat(1_000_000);
    items.update('A', 'partial', draft);
    items.update('A', 'partial', 'overflow');
    expect(items.error).toMatch(/pending text limit/);
    expect(items.finish()).toBe(draft);
  });

  it('preflights the pending-text limit before applying predecessor metadata', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.register('B', 'A');
    items.update('A', 'partial', 'first');
    items.update('B', 'partial', 'second');
    items.update('A', 'partial', 'x'.repeat(1_000_000), undefined, 'B');
    expect(items.error).toMatch(/pending text limit/);
    expect(items.preview()).toBe('first second');
    expect(items.finish()).toBe('first second');
  });

  it('bounds retained event text without erasing pending text', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    const draft = 'x'.repeat(1_000_000);
    items.update('A', 'partial', draft, 'first');
    items.update('A', 'final', 'final', 'second');
    expect(items.error).toMatch(/event text limit/);
    expect(items.finish()).toBe(draft);
  });

  it('bounds retained resolved text while preserving the pending item', () => {
    const items = new LiveUtterances();
    items.register('A', null);
    items.register('B', 'A');
    const first = 'x'.repeat(1_000_000);
    expect(items.update('A', 'final', first)).toBe(first);
    items.update('B', 'partial', 'second');
    expect(items.update('B', 'final', 'changed final')).toBe('');
    expect(items.error).toMatch(/resolved text limit/);
    expect(items.finish()).toBe('second');
  });

  it('rejects cyclic or conflicting predecessor metadata while preserving drafts', () => {
    const cycle = new LiveUtterances();
    cycle.register('B', 'A');
    cycle.update('B', 'partial', 'saved');
    cycle.register('A', 'B');
    expect(cycle.error).toMatch(/cycle/);
    expect(cycle.finish()).toBe('[Live item; order unconfirmed]\nsaved');

    const conflict = new LiveUtterances();
    conflict.register('B', 'A');
    conflict.register('B', 'C');
    expect(conflict.error).toMatch(/conflicting predecessor/);
  });
});
