export const joinTranscriptText = (finalText: string, liveDraft: string) => {
  if (!liveDraft) return finalText;
  return `${finalText}${finalText && !finalText.endsWith(' ') ? ' ' : ''}${liveDraft}`.trimStart();
};

export const appendRealtimeDelta = (currentDraft: string, delta: string) =>
  `${currentDraft}${delta}`;

// Keep recent resolved IDs to suppress late events without growing for the whole session.
const MAX_RESOLVED_ITEMS = 1024;

/** Tracks items until their predecessors finish, so a late final cannot reorder speech. */
export class LiveUtterances {
  private items: Array<{ id: string; text: string; final: boolean; previous?: string }> = [];
  private resolved = new Set<string>();
  private anonymousDiscarded = false;
  private events = new Set<string>();

  private resolve(id: string) {
    if (id === 'anonymous' || this.resolved.has(id)) return;
    this.resolved.add(id);
    if (this.resolved.size > MAX_RESOLVED_ITEMS) {
      this.resolved.delete(this.resolved.values().next().value!);
    }
  }

  private id(value: unknown): string {
    return typeof value === 'string' && value.trim() ? `id:${value}` : 'anonymous';
  }

  private flush() {
    let committed = '';
    while (this.items[0]?.final &&
      (!this.items[0].previous || this.resolved.has(this.items[0].previous))) {
      const item = this.items.shift()!;
      this.resolve(item.id);
      committed = joinTranscriptText(committed, item.text);
    }
    return committed;
  }

  private order() {
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const ordered: typeof this.items = [];
    const visit = (item: typeof this.items[number]) => {
      if (visited.has(item.id) || visiting.has(item.id)) return;
      visiting.add(item.id);
      const predecessor = item.previous && byId.get(item.previous);
      if (predecessor) visit(predecessor);
      visiting.delete(item.id);
      visited.add(item.id);
      ordered.push(item);
    };
    this.items.forEach(visit);
    this.items = ordered;
  }

  register(value: unknown, previous?: unknown) {
    const id = this.id(value);
    if (this.resolved.has(id)) return '';
    const existing = this.items.find((item) => item.id === id);
    if (existing) {
      if (typeof previous === 'string' && previous.trim()) existing.previous = this.id(previous);
      this.order();
      return this.flush();
    }
    const previousId = typeof previous === 'string' && previous.trim() ? this.id(previous) : undefined;
    const item = { id, text: '', final: false, previous: previousId };
    this.items.push(item);
    this.order();
    return this.flush();
  }

  // A known non-audio predecessor cannot produce a transcription completion.
  skip(value: unknown, previous?: unknown) {
    const id = this.id(value);
    if (id === 'anonymous' || this.resolved.has(id)) return '';
    const committed = this.register(value, previous);
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return committed;
    item.text = '';
    item.final = true;
    return joinTranscriptText(committed, this.flush());
  }

  update(value: unknown, kind: 'partial' | 'final', text: string, eventId?: unknown) {
    const id = this.id(value);
    if (typeof eventId === 'string' && eventId.trim()) {
      if (this.events.has(eventId)) return '';
      this.events.add(eventId);
      if (this.events.size > MAX_RESOLVED_ITEMS) this.events.delete(this.events.values().next().value!);
    }
    if (this.resolved.has(id) || (id === 'anonymous' && this.anonymousDiscarded)) {
      if (kind === 'final' && id === 'anonymous') this.anonymousDiscarded = false;
      return '';
    }
    const committed = this.register(value);
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.final) return committed;
    item.text = kind === 'partial' ? appendRealtimeDelta(item.text, text) : text;
    item.final = kind === 'final';
    return joinTranscriptText(committed, this.flush());
  }

  preview() {
    return this.items.reduce((text, item) => joinTranscriptText(text, item.text), '');
  }

  discard() {
    for (const item of this.items) {
      if (item.id === 'anonymous') this.anonymousDiscarded = true;
      else this.resolve(item.id);
    }
    this.items = [];
  }

  finish() {
    const text = this.preview();
    this.items = [];
    return text;
  }
}
