import { describe, expect, it } from 'vitest';

import { LiveUtterances, joinTranscriptText } from '@/src/lib/liveTranscript';

class Capture {
  tracker = new LiveUtterances();
  committed = '';

  add(text: string) {
    this.committed = joinTranscriptText(this.committed, text);
  }

  register(item: string, previous?: string | null) {
    this.add(this.tracker.register(item, previous, true));
  }

  update(
    item: string,
    kind: 'partial' | 'final',
    text: string,
    eventId: string,
    contentIndex?: unknown
  ) {
    this.add(this.tracker.update(item, kind, text, eventId, undefined, false, contentIndex));
  }

  displayed() {
    return joinTranscriptText(this.committed, this.tracker.preview());
  }

  finish() {
    this.add(this.tracker.finish());
    return this.committed;
  }
}

function occurrences(text: string, value: string) {
  return text.split(value).length - 1;
}

function expectRetainedOrPartAware(capture: Capture, first: string, second: string) {
  const displayed = capture.displayed();
  expect(displayed).toContain(first);
  if (capture.tracker.error) {
    expect(capture.finish()).toContain(first);
  } else {
    expect(displayed).toContain(second);
    expect(displayed).not.toContain(`${first}${second}`);
  }
}

describe('LiveUtterances content identity', () => {
  it.each([
    ['legacy index absent', undefined],
    ['explicit index zero', 0]
  ])('keeps the ordinary single-audio path with %s', (_name, contentIndex) => {
    const capture = new Capture();
    capture.register('audio', null);
    capture.update('audio', 'partial', 'one ', 'delta-1', contentIndex);
    capture.update('audio', 'partial', 'one ', 'delta-1', contentIndex);
    capture.update('audio', 'partial', 'two', 'delta-2', contentIndex);
    expect(capture.displayed()).toBe('one two');
    capture.update('audio', 'final', 'one two', 'final-1', contentIndex);
    expect(capture.displayed()).toBe('one two');
    expect(capture.tracker.error).toBe('');
    expect(capture.finish()).toBe('one two');
  });

  it.each([
    ['null', null],
    ['negative', -1],
    ['fraction', 0.5],
    ['string', '0'],
    ['object', { index: 0 }],
    ['array', [0]],
    ['boolean', false],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1]
  ])('does not treat a malformed %s index as an absent legacy index', (_name, index) => {
    for (const kind of ['partial', 'final'] as const) {
      const capture = new Capture();
      capture.register('seed', null);
      capture.update('seed', 'final', 'accepted seed', 'seed-final', 0);
      capture.register('target', 'seed');
      capture.update('target', kind, 'MALFORMED-SPEECH', `bad-${kind}`, index);
      expect(capture.tracker.error || capture.tracker.identityUncertain).toBeTruthy();
      expect(capture.displayed()).toContain('accepted seed');
      const retained = capture.finish();
      expect(retained).toContain('accepted seed');
      if (retained.includes('MALFORMED-SPEECH')) {
        expect(retained).toMatch(/unconfirmed|uncertain|unsupported|invalid|malformed/i);
      }
    }
  });

  it.each([
    [0, 1],
    [1, 0]
  ])(
    'does not merge indexed partials %i then %i before processing their finals',
    (firstIndex, secondIndex) => {
      const capture = new Capture();
      capture.register('item', null);
      capture.update('item', 'partial', 'alpha', 'partial-first', firstIndex);
      capture.update('item', 'partial', 'beta', 'partial-second', secondIndex);
      expectRetainedOrPartAware(capture, 'alpha', 'beta');
      if (capture.tracker.error) return;

      capture.update('item', 'final', 'alpha', 'final-first', firstIndex);
      expect(capture.displayed()).toContain('beta');
      expectRetainedOrPartAware(capture, 'alpha', 'beta');
      if (capture.tracker.error) return;

      capture.update('item', 'final', 'beta', 'final-second', secondIndex);
      expectRetainedOrPartAware(capture, 'alpha', 'beta');
      const retained = capture.finish();
      expect(retained).toContain('alpha');
      expect(retained).toContain('beta');
      expect(occurrences(retained, 'alpha')).toBe(1);
      expect(occurrences(retained, 'beta')).toBe(1);
    }
  );

  it.each([
    ['equal', 'same speech', 'same speech'],
    ['unequal', 'first speech', 'second speech']
  ])('keeps %s finals from different indexes distinct or fences them', (_name, first, second) => {
    const capture = new Capture();
    capture.register('item', null);
    capture.update('item', 'final', first, 'final-index-zero', 0);
    expect(capture.displayed()).toContain(first);
    capture.update('item', 'final', second, 'final-index-one', 1);
    const retained = capture.finish();
    expect(retained).toContain(first);
    if (!capture.tracker.error) {
      expect(occurrences(retained, first)).toBe(first === second ? 2 : 1);
      if (first !== second) expect(occurrences(retained, second)).toBe(1);
    }
  });

  it('checks index identity even when the first final remains pending', () => {
    const capture = new Capture();
    capture.update('item', 'final', 'same speech', 'pending-zero', 0);
    expect(capture.tracker.orderUncertain).toBe(true);
    capture.update('item', 'final', 'same speech', 'pending-one', 1);
    const retained = capture.finish();
    expect(retained).toContain('same speech');
    if (!capture.tracker.error) expect(occurrences(retained, 'same speech')).toBe(2);
  });

  it('treats an exact identified replay differently from index-changing ID reuse', () => {
    const capture = new Capture();
    capture.register('item', null);
    capture.update('item', 'final', 'accepted', 'event-id', 0);
    capture.update('item', 'final', 'accepted', 'event-id', 0);
    expect(capture.displayed()).toBe('accepted');
    expect(capture.tracker.error).toBe('');
    capture.update('item', 'final', 'accepted', 'event-id', 1);
    expect(capture.tracker.error).not.toBe('');
    expect(capture.finish()).toBe('accepted');
  });

  it('distinguishes equal finals for genuine item IDs and reconciles late predecessors', () => {
    const capture = new Capture();
    capture.update('second', 'final', 'same speech', 'event-second', 0);
    capture.update('first', 'final', 'same speech', 'event-first', 0);
    expect(capture.tracker.orderUncertain).toBe(true);
    capture.register('second', 'first');
    capture.register('first', null);
    expect(capture.tracker.error).toBe('');
    expect(capture.tracker.orderUncertain).toBe(false);
    expect(capture.displayed()).toBe('same speech same speech');
    expect(capture.finish()).toBe('same speech same speech');
  });

  it('confirms a single-part reference without adding it twice', () => {
    const capture = new Capture();
    capture.add(capture.tracker.registerReference('item', null, 'reference speech'));
    expect(capture.tracker.referenceUncertain).toBe(true);
    expect(capture.displayed()).toBe('');
    capture.update('item', 'final', 'reference speech', 'matching-final', 0);
    expect(capture.tracker.referenceUncertain).toBe(false);
    expect(capture.tracker.error).toBe('');
    expect(capture.finish()).toBe('reference speech');
  });

  it('keeps a failed pending item and its partial text in predecessor order', () => {
    const capture = new Capture();
    capture.register('failed', 'first');
    capture.update('failed', 'partial', 'retained partial', 'partial-event', 0);
    capture.add(capture.tracker.fail('failed', undefined, 'failure-event'));
    expect(capture.tracker.orderUncertain).toBe(true);
    expect(capture.displayed()).toBe('retained partial');
    capture.register('first', null);
    capture.update('first', 'final', 'first speech', 'first-final', 0);
    expect(capture.tracker.error).toBe('');
    expect(capture.finish()).toBe('first speech retained partial');
  });

  it('deduplicates a legacy failure and preserves text on a later conflicting completion', () => {
    const capture = new Capture();
    capture.register('item', null);
    capture.update('item', 'partial', 'retained partial', 'partial-event', 0);
    capture.add(capture.tracker.fail('item', undefined, 'failure-event'));
    capture.add(capture.tracker.fail('item', undefined, 'failure-event'));
    expect(capture.displayed()).toBe('retained partial');
    expect(capture.tracker.error).toBe('');
    capture.update('item', 'final', 'different final', 'later-final', 0);
    expect(capture.tracker.error).not.toBe('');
    expect(capture.finish()).toBe('retained partial');
  });

  it('fences at the event-count bound without evicting identities or pending text', () => {
    const capture = new Capture();
    capture.register('item', null);
    capture.update('item', 'partial', 'retained partial', 'draft-event', 0);
    for (let index = 0; index < 4095; index++) {
      const eventId = `event-${index}`;
      expect(capture.tracker.trackEvent(eventId, JSON.stringify({ event_id: eventId }))).toBe(
        'accepted'
      );
    }
    expect(capture.tracker.trackEvent('overflow', '{"event_id":"overflow"}')).toBe('rejected');
    expect(capture.tracker.error).toMatch(/limit/i);
    expect(capture.finish()).toContain('retained partial');
  });

  it('retains accepted text on a bounded-ID rejection and ignores events after finish', () => {
    const capture = new Capture();
    capture.register('item', null);
    capture.update('item', 'final', 'accepted', 'valid-event', 0);
    capture.update('another', 'partial', 'not accepted', 'x'.repeat(257), 0);
    expect(capture.tracker.error).not.toBe('');
    expect(capture.finish()).toBe('accepted');
    capture.update('later', 'final', 'stale', 'late-event', 0);
    expect(capture.displayed()).toBe('accepted');
  });
});
