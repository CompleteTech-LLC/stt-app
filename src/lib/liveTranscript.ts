export const joinTranscriptText = (finalText: string, liveDraft: string) => {
  if (!liveDraft) return finalText;
  return `${finalText}${finalText && !/\s$/.test(finalText) ? ' ' : ''}${liveDraft}`;
};

export const appendRealtimeDelta = (currentDraft: string, delta: string) =>
  `${currentDraft}${delta}`;

export const unconfirmedLiveIdentityLabel = '[Live item; event identity unconfirmed]';
export const incompleteLiveContentLabel =
  '[Live audio content identity unconfirmed; speech may be missing]';

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
  identityUncertain: boolean;
  reference?: string;
  referenceConfirmed?: boolean;
  contentIndex?: number;
  previous?: string;
  previousKnown: boolean;
  terminal?: 'non-audio' | 'failed';
};

type TrackedEvent =
  | {
      itemId: string;
      kind: 'partial' | 'final' | 'failed';
      text: string;
      previous?: unknown;
      contentIndex?: unknown;
    }
  | { serialized: string };

type ResolvedItem = {
  terminal: 'final' | 'non-audio' | 'failed';
  order: number;
  previous?: string;
  previousKnown: boolean;
  text: string;
  referenceConfirmed?: boolean;
  contentIndex?: number;
};

export class LiveUtterances {
  private items: LiveItem[] = [];
  private known = new Set<string>();
  private resolved = new Map<string, ResolvedItem>();
  private successors = new Map<string, string>();
  private events = new Map<string, TrackedEvent>();
  private acknowledgedItems = new Set<string>();
  private eventTextLength = 0;
  private resolvedTextLength = 0;
  private lastResolvedId: string | undefined;
  private halted = '';
  private incompleteContent = false;

  constructor(private active = true) {}

  get error() {
    return this.halted;
  }

  get contentIncomplete() {
    return this.incompleteContent;
  }

  reject(reason: string) {
    if (this.active && !this.halted) {
      this.halted = `Live transcription paused: ${reason} Stop and Start a new session.`;
    }
  }

  rejectContent(reason: string) {
    if (!this.active || this.halted) return;
    this.incompleteContent = true;
    this.reject(reason);
  }

  validateContentIndex(value: unknown, contentIndex: unknown) {
    if (!this.active || this.halted) return false;
    if (contentIndex === undefined) return true;
    if (
      typeof contentIndex !== 'number' ||
      !Number.isSafeInteger(contentIndex) ||
      contentIndex < 0
    ) {
      this.rejectContent('a transcription has a malformed content index.');
      return false;
    }
    const target =
      this.items.find((item) => item.id === value) ??
      (typeof value === 'string' ? this.resolved.get(value) : undefined);
    if (target?.contentIndex !== undefined && target.contentIndex !== contentIndex) {
      this.rejectContent('a transcription has a conflicting content index.');
      return false;
    }
    return true;
  }

  private bindContentIndex(value: unknown, contentIndex: unknown) {
    if (typeof value !== 'string' || typeof contentIndex !== 'number') return;
    const target = this.items.find((item) => item.id === value) ?? this.resolved.get(value);
    if (target) target.contentIndex = contentIndex;
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

  trackEvent(eventId: unknown, serialized: string) {
    if (!this.active || this.halted) return 'rejected';
    if (eventId === undefined) return 'unidentified';
    if (!this.validId(eventId)) {
      this.reject('an event ID was malformed.');
      return 'rejected';
    }
    const existing = this.events.get(eventId);
    if (existing) {
      if (!('serialized' in existing) || existing.serialized !== serialized) {
        this.reject('an event ID was reused with different identity or content.');
        return 'rejected';
      }
      return 'duplicate';
    }
    if (this.events.size >= MAX_TRACKED_EVENTS) {
      this.reject('the session event limit was reached.');
      return 'rejected';
    }
    if (this.eventTextLength + serialized.length > MAX_EVENT_TEXT) {
      this.reject('the session event text limit was reached.');
      return 'rejected';
    }
    this.events.set(eventId, { serialized });
    this.eventTextLength += serialized.length;
    return 'accepted';
  }

  acknowledge(value: unknown) {
    if (!this.active || this.halted || !this.validId(value)) return false;
    if (this.acknowledgedItems.has(value)) return false;
    if (this.acknowledgedItems.size >= MAX_TRACKED_ITEMS) {
      this.reject('the session acknowledgement limit was reached.');
      return false;
    }
    this.acknowledgedItems.add(value);
    return true;
  }

  private rememberEvent(
    eventId: unknown,
    value: unknown,
    kind: 'partial' | 'final' | 'failed',
    text: string,
    previous?: unknown,
    contentIndex?: unknown
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
        !('itemId' in existing) ||
        existing.itemId !== value ||
        existing.kind !== kind ||
        existing.text !== text ||
        existing.previous !== previous ||
        existing.contentIndex !== contentIndex
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
    this.events.set(eventId, { itemId: value, kind, text, previous, contentIndex });
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
        text: item.text,
        referenceConfirmed: item.referenceConfirmed,
        contentIndex: item.contentIndex
      });
      this.lastResolvedId = item.id;
      this.resolvedTextLength += item.text.length;
      const text =
        item.identityUncertain && item.text
          ? `${unconfirmedLiveIdentityLabel}\n${item.text}`
          : item.text;
      committed = joinTranscriptText(committed, text);
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

  registerAudioPart(value: unknown, previous: unknown, contentIndex: number) {
    return this.transact(() => {
      if (!this.validateContentIndex(value, contentIndex)) return '';
      this.bindContentIndex(value, contentIndex);
      const committed = this.registerItem(value, previous, true);
      if (!this.halted) this.bindContentIndex(value, contentIndex);
      return committed;
    });
  }

  registerReference(value: unknown, previous: unknown, text: string) {
    return this.transact(() => {
      const item = this.items.find((entry) => entry.id === value);
      const resolved = typeof value === 'string' ? this.resolved.get(value) : undefined;
      const target = item ?? resolved;
      if (!this.validateContentIndex(value, 0)) return '';
      if (resolved || item?.final) {
        if (
          (resolved && resolved.terminal !== 'final') ||
          item?.terminal ||
          target?.text !== text
        ) {
          this.reject('a reference transcript conflicts with the completed transcription.');
          return '';
        }
        if (target) target.referenceConfirmed = true;
      } else {
        if (item?.reference !== undefined && item.reference !== text) {
          this.reject('an item has conflicting reference transcripts.');
          return '';
        }
        const pendingLength = this.items.reduce(
          (sum, entry) => sum + entry.text.length + (entry.reference?.length ?? 0),
          0
        );
        if (pendingLength + (item?.reference === undefined ? text.length : 0) > MAX_PENDING_TEXT) {
          this.reject('the pending text limit was reached.');
          return '';
        }
      }
      this.bindContentIndex(value, 0);
      const committed = this.registerItem(value, previous, true);
      if (this.halted || typeof value !== 'string') return committed;
      this.bindContentIndex(value, 0);
      const pending = this.items.find((entry) => entry.id === value);
      if (pending && !pending.final) pending.reference = text;
      return committed;
    });
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
        identityUncertain: false,
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
    previous?: unknown,
    unidentified = eventId === undefined || eventId === null,
    contentIndex?: unknown
  ) {
    return this.transact(() => {
      if (!this.validateContentIndex(value, contentIndex)) return '';
      if (!this.rememberEvent(eventId, value, kind, text, previous, contentIndex)) return '';
      const existing = this.items.find((entry) => entry.id === value);
      const resolved = typeof value === 'string' ? this.resolved.get(value) : undefined;
      if (kind === 'final' && existing?.reference !== undefined && existing.reference !== text) {
        this.reject('a reference transcript conflicts with the completed transcription.');
        return '';
      }
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
          this.items.reduce(
            (sum, entry) => sum + entry.text.length + (entry.reference?.length ?? 0),
            0
          ) -
          currentLength -
          (kind === 'final' ? (existing?.reference?.length ?? 0) : 0);
        if (otherLength + nextLength > MAX_PENDING_TEXT) {
          this.reject('the pending text limit was reached.');
          return '';
        }
      }
      this.bindContentIndex(value, contentIndex);
      const committed = this.registerItem(value, previous, true);
      if (this.halted || typeof value !== 'string') return committed;
      this.bindContentIndex(value, contentIndex);
      const item = this.items.find((entry) => entry.id === value);
      if (!item || item.final) return committed;
      item.text = kind === 'partial' ? appendRealtimeDelta(item.text, text) : text;
      item.final = kind === 'final';
      if (item.final && item.reference !== undefined) {
        item.reference = undefined;
        item.referenceConfirmed = true;
      }
      item.identityUncertain =
        kind === 'partial' && (item.identityUncertain || (unidentified && !!text));
      return joinTranscriptText(committed, this.flush());
    });
  }

  fail(value: unknown, previous?: unknown, eventId?: unknown, contentIndex?: unknown) {
    return this.transact(() => {
      if (!this.validateContentIndex(value, contentIndex)) return '';
      if (!this.rememberEvent(eventId, value, 'failed', '', previous, contentIndex)) return '';
      const existing = this.items.find((entry) => entry.id === value);
      const resolved = typeof value === 'string' ? this.resolved.get(value) : undefined;
      if (existing?.reference !== undefined) {
        this.reject('a reference transcript could not be confirmed after transcription failed.');
        return '';
      }
      if (
        (existing?.final && existing.terminal !== 'failed') ||
        (resolved && resolved.terminal !== 'failed')
      ) {
        this.reject('a terminal item received a conflicting transcription failure.');
        return '';
      }
      this.bindContentIndex(value, contentIndex);
      const committed = this.registerItem(value, previous, true);
      if (this.halted || typeof value !== 'string') return committed;
      this.bindContentIndex(value, contentIndex);
      const item = this.items.find((entry) => entry.id === value);
      if (!item || item.final) return committed;
      item.final = true;
      item.terminal = 'failed';
      return joinTranscriptText(committed, this.flush());
    });
  }

  preview() {
    const text = this.items.reduce((result, item) => joinTranscriptText(result, item.text), '');
    return this.incompleteContent
      ? `${text}${text ? '\n\n' : ''}${incompleteLiveContentLabel}`
      : text;
  }

  get orderUncertain() {
    let previous = this.lastResolvedId;
    for (const item of this.items) {
      if (!item.previousKnown || item.previous !== previous) return true;
      previous = item.id;
    }
    return false;
  }

  get identityUncertain() {
    return this.items.some((item) => item.identityUncertain && !!item.text);
  }

  get referenceUncertain() {
    return this.items.some((item) => item.reference !== undefined);
  }

  discard() {
    this.items = [];
    this.incompleteContent = false;
    this.events.clear();
    this.acknowledgedItems.clear();
    this.eventTextLength = 0;
    this.reject('the workspace changed while this session was active.');
  }

  finish() {
    const orderUncertain = this.orderUncertain;
    const text = this.items.reduce((result, item) => {
      if (!item.text) return result;
      const labels = [
        orderUncertain ? '[Live item; order unconfirmed]' : '',
        item.identityUncertain ? unconfirmedLiveIdentityLabel : ''
      ].filter(Boolean);
      const retained = labels.length ? `${labels.join('\n')}\n${item.text}` : item.text;
      return orderUncertain && result
        ? `${result}\n\n${retained}`
        : joinTranscriptText(result, retained);
    }, '');
    const retained = this.incompleteContent
      ? `${text}${text ? '\n\n' : ''}${incompleteLiveContentLabel}`
      : text;
    this.items = [];
    this.incompleteContent = false;
    this.events.clear();
    this.acknowledgedItems.clear();
    this.eventTextLength = 0;
    this.active = false;
    return retained;
  }
}
