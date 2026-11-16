export const joinTranscriptText = (finalText: string, liveDraft: string) => {
  if (!liveDraft) return finalText;
  return `${finalText}${finalText && !/\s$/.test(finalText) ? ' ' : ''}${liveDraft}`;
};

export const appendRealtimeDelta = (currentDraft: string, delta: string) =>
  `${currentDraft}${delta}`;

const MAX_TRACKED_ITEMS = 1024;
const MAX_TRACKED_EVENTS = 4096;
const MAX_ID_LENGTH = 256;
const MAX_PENDING_TEXT = 1_000_000;
const MAX_EVENT_TEXT = 1_000_000;
const MAX_RESOLVED_TEXT = 1_000_000;

type LiveItem = {
  id: string;
  text: string;
  final: boolean;
  audio: boolean;
  previous?: string;
  previousKnown: boolean;
  terminal?: 'non-audio' | 'failed';
};

type TrackedEvent = {
  itemId: string;
  kind: 'partial' | 'final' | 'failed';
  text: string;
  previous?: unknown;
};

type ResolvedItem = {
  terminal: 'final' | 'non-audio' | 'failed';
  order: number;
  previous?: string;
  previousKnown: boolean;
  text: string;
};

export class LiveUtterances {
  private items: LiveItem[] = [];
  private known = new Set<string>();
  private resolved = new Map<string, ResolvedItem>();
  private successors = new Map<string, string>();
  private events = new Map<string, TrackedEvent>();
  private eventTextLength = 0;
  private resolvedTextLength = 0;
  private lastResolvedId: string | undefined;
  private halted = '';

  constructor(private active = true) {}

  get error() {
    return this.halted;
  }

  reject(reason: string) {
    if (this.active && !this.halted) {
      this.halted = `Live transcription paused: ${reason} Stop and Start a new session.`;
    }
  }

  private transact(action: () => string) {
    if (!this.active || this.halted) return '';
    const snapshot = {
      items: this.items.map((item) => ({ ...item })),
      known: new Set(this.known),
      resolved: new Map<string, ResolvedItem>(
        [...this.resolved].map(([id, item]) => [id, { ...item }])
      ),
      successors: new Map(this.successors),
      events: new Map(this.events),
      eventTextLength: this.eventTextLength,
      resolvedTextLength: this.resolvedTextLength,
      lastResolvedId: this.lastResolvedId
    };
    const restore = () => {
      this.items = snapshot.items;
      this.known = snapshot.known;
      this.resolved = snapshot.resolved;
      this.successors = snapshot.successors;
      this.events = snapshot.events;
      this.eventTextLength = snapshot.eventTextLength;
      this.resolvedTextLength = snapshot.resolvedTextLength;
      this.lastResolvedId = snapshot.lastResolvedId;
    };
    try {
      const committed = action();
      if (this.halted) {
        restore();
        return '';
      }
      return committed;
    } catch (error) {
      restore();
      throw error;
    }
  }

  private validId(value: unknown): value is string {
    return typeof value === 'string' && !!value.trim() && value.length <= MAX_ID_LENGTH;
  }

  private remember(ids: string[]) {
    const missing = new Set(ids.filter((id) => !this.known.has(id)));
    if (this.known.size + missing.size > MAX_TRACKED_ITEMS) {
      this.reject('the session item limit was reached.');
      return false;
    }
    missing.forEach((id) => this.known.add(id));
    return true;
  }

  private rememberEvent(
    eventId: unknown,
    value: unknown,
    kind: TrackedEvent['kind'],
    text: string,
    previous?: unknown
  ) {
    if (!this.validId(value)) {
      this.reject('an item ID was missing or malformed.');
      return false;
    }
    if (previous !== undefined && previous !== null && !this.validId(previous)) {
      this.reject('a predecessor ID was malformed.');
      return false;
    }
    if (eventId === undefined || eventId === null) return true;
    if (!this.validId(eventId)) {
      this.reject('an event ID was malformed.');
      return false;
    }
    const existing = this.events.get(eventId);
    if (existing) {
      if (
        existing.itemId !== value ||
        existing.kind !== kind ||
        existing.text !== text ||
        existing.previous !== previous
      ) {
        this.reject('an event ID was reused with different identity or content.');
      }
      return false;
    }
    if (this.events.size >= MAX_TRACKED_EVENTS) {
      this.reject('the session event limit was reached.');
      return false;
    }
    if (this.eventTextLength + text.length > MAX_EVENT_TEXT) {
      this.reject('the session event text limit was reached.');
      return false;
    }
    this.events.set(eventId, { itemId: value, kind, text, previous });
    this.eventTextLength += text.length;
    return true;
  }

  private flush() {
    let committed = '';
    while (
      this.items[0]?.final &&
      this.items[0].previousKnown &&
      this.items[0].previous === this.lastResolvedId
    ) {
      const pending = this.items[0];
      if (pending.previous && pending.previous !== this.lastResolvedId) {
        this.reject('a predecessor conflicts with the committed item order.');
        break;
      }
      if (this.resolvedTextLength + pending.text.length > MAX_RESOLVED_TEXT) {
        this.reject('the session resolved text limit was reached.');
        break;
      }
      const item = this.items.shift()!;
      this.resolved.set(item.id, {
        terminal: item.terminal ?? 'final',
        order: this.resolved.size,
        previous: item.previous,
        previousKnown: item.previousKnown,
        text: item.text
      });
      this.lastResolvedId = item.id;
      this.resolvedTextLength += item.text.length;
      committed = joinTranscriptText(committed, item.text);
    }
    return committed;
  }

  private order() {
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const children = new Map<string, LiveItem>();
    this.items.forEach((item) => {
      if (item.previous && byId.has(item.previous)) children.set(item.previous, item);
    });
    const roots = this.items.filter((item) => !item.previous || !byId.has(item.previous));
    const next = this.lastResolvedId
      ? roots.find((item) => item.previous === this.lastResolvedId)
      : roots.find((item) => item.previousKnown && !item.previous);
    if (next) roots.splice(roots.indexOf(next), 1);
    const ordered: LiveItem[] = [];
    if (next) roots.unshift(next);
    roots.forEach((root) => {
      let item: LiveItem | undefined = root;
      while (item) {
        ordered.push(item);
        item = children.get(item.id);
      }
    });
    this.items = ordered;
  }

  register(value: unknown, previous?: unknown, audio = false) {
    return this.transact(() => this.registerItem(value, previous, audio));
  }

  private registerItem(value: unknown, previous?: unknown, audio = false) {
    if (!this.active || this.halted) return '';
    if (!this.validId(value)) {
      this.reject('an item ID was missing or malformed.');
      return '';
    }
    if (previous !== undefined && previous !== null && !this.validId(previous)) {
      this.reject('a predecessor ID was malformed.');
      return '';
    }
    const previousId = typeof previous === 'string' ? previous : undefined;
    if (!this.remember(previousId ? [value, previousId] : [value])) return '';
    const successor = previousId ? this.successors.get(previousId) : undefined;
    if (successor && successor !== value) {
      this.reject('multiple items claim the same predecessor.');
      return '';
    }
    const resolved = this.resolved.get(value);
    if (previous === null) {
      const pendingRoot = this.items.find((item) => item.previousKnown && !item.previous);
      const resolvedRoot = [...this.resolved].find(
        ([, item]) => item.previousKnown && !item.previous
      );
      if (
        (pendingRoot && pendingRoot.id !== value) ||
        (resolvedRoot && resolvedRoot[0] !== value)
      ) {
        this.reject('multiple items claim to be the first item.');
        return '';
      }
      if (this.resolved.size && (!resolved || resolved.order !== 0)) {
        this.reject('first-item metadata conflicts with the committed item order.');
        return '';
      }
    }
    if (resolved) {
      const predecessor = previousId ? this.resolved.get(previousId) : undefined;
      if (audio && resolved.terminal === 'non-audio') {
        this.reject('audio arrived for an item previously identified as non-audio.');
      } else if (
        resolved.previousKnown &&
        previous !== undefined &&
        resolved.previous !== previousId
      ) {
        this.reject('an item has conflicting predecessor IDs.');
      } else if (previousId && (!predecessor || predecessor.order !== resolved.order - 1)) {
        this.reject('predecessor metadata arrived after an item was committed.');
      } else if (previous !== undefined) {
        resolved.previous = previousId;
        resolved.previousKnown = true;
        if (previousId) this.successors.set(previousId, value);
      }
      return '';
    }
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const existing = byId.get(value);
    if (audio && existing?.terminal === 'non-audio') {
      this.reject('audio arrived for an item previously identified as non-audio.');
      return '';
    }
    if (existing?.previousKnown && previous !== undefined && existing.previous !== previousId) {
      this.reject('an item has conflicting predecessor IDs.');
      return '';
    }
    let ancestor = previousId;
    while (ancestor) {
      if (ancestor === value) {
        this.reject('the item predecessor chain contains a cycle.');
        return '';
      }
      ancestor = byId.get(ancestor)?.previous;
    }
    if (previousId && this.resolved.has(previousId) && previousId !== this.lastResolvedId) {
      this.reject('a predecessor conflicts with the committed item order.');
      return '';
    }
    if (previousId) this.successors.set(previousId, value);
    if (existing) {
      if (previous !== undefined) {
        existing.previous = previousId;
        existing.previousKnown = true;
      }
      existing.audio ||= audio;
    } else {
      this.items.push({
        id: value,
        text: '',
        final: false,
        audio,
        previous: previousId,
        previousKnown: previous !== undefined
      });
    }
    this.order();
    return this.flush();
  }

  skip(value: unknown, previous?: unknown) {
    return this.transact(() => {
      const existing = this.items.find((entry) => entry.id === value);
      const resolved = typeof value === 'string' ? this.resolved.get(value) : undefined;
      if (existing?.audio || (resolved && resolved.terminal !== 'non-audio')) {
        this.reject('a non-audio item conflicts with an item identified as audio.');
        return '';
      }
      const committed = this.registerItem(value, previous);
      if (this.halted || typeof value !== 'string') return committed;
      const item = this.items.find((entry) => entry.id === value);
      if (!item || item.audio || item.final) return committed;
      item.final = true;
      item.terminal = 'non-audio';
      return joinTranscriptText(committed, this.flush());
    });
  }

  update(
    value: unknown,
    kind: 'partial' | 'final',
    text: string,
    eventId?: unknown,
    previous?: unknown
  ) {
    return this.transact(() => {
      if (!this.rememberEvent(eventId, value, kind, text, previous)) return '';
      const existing = this.items.find((entry) => entry.id === value);
      const resolved = typeof value === 'string' ? this.resolved.get(value) : undefined;
      if (
        (existing?.final && (existing.terminal || kind !== 'final' || existing.text !== text)) ||
        (resolved && (resolved.terminal !== 'final' || kind !== 'final' || resolved.text !== text))
      ) {
        this.reject('a terminal item received conflicting transcription text.');
        return '';
      }
      if (!existing?.final && !resolved) {
        const currentLength = existing?.text.length ?? 0;
        const nextLength = kind === 'partial' ? currentLength + text.length : text.length;
        const otherLength =
          this.items.reduce((sum, entry) => sum + entry.text.length, 0) - currentLength;
        if (otherLength + nextLength > MAX_PENDING_TEXT) {
          this.reject('the pending text limit was reached.');
          return '';
        }
      }
      const committed = this.registerItem(value, previous, true);
      if (this.halted || typeof value !== 'string') return committed;
      const item = this.items.find((entry) => entry.id === value);
      if (!item || item.final) return committed;
      item.text = kind === 'partial' ? appendRealtimeDelta(item.text, text) : text;
      item.final = kind === 'final';
      return joinTranscriptText(committed, this.flush());
    });
  }

  fail(value: unknown, previous?: unknown, eventId?: unknown) {
    return this.transact(() => {
      if (!this.rememberEvent(eventId, value, 'failed', '', previous)) return '';
      const existing = this.items.find((entry) => entry.id === value);
      const resolved = typeof value === 'string' ? this.resolved.get(value) : undefined;
      if (
        (existing?.final && existing.terminal !== 'failed') ||
        (resolved && resolved.terminal !== 'failed')
      ) {
        this.reject('a terminal item received a conflicting transcription failure.');
        return '';
      }
      const committed = this.registerItem(value, previous, true);
      if (this.halted || typeof value !== 'string') return committed;
      const item = this.items.find((entry) => entry.id === value);
      if (!item || item.final) return committed;
      item.final = true;
      item.terminal = 'failed';
      return joinTranscriptText(committed, this.flush());
    });
  }

  preview() {
    return this.items.reduce((text, item) => joinTranscriptText(text, item.text), '');
  }

  get orderUncertain() {
    let previous = this.lastResolvedId;
    for (const item of this.items) {
      if (!item.previousKnown || item.previous !== previous) return true;
      previous = item.id;
    }
    return false;
  }

  discard() {
    this.items = [];
    this.reject('the workspace changed while this session was active.');
  }

  finish() {
    const text = this.orderUncertain
      ? this.items
          .filter((item) => item.text)
          .map((item) => `[Live item; order unconfirmed]\n${item.text}`)
          .join('\n\n')
      : this.preview();
    this.items = [];
    this.active = false;
    return text;
  }
}
