import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type ServerEvent = Record<string, unknown>;
type ExportKind = 'TXT' | 'JSON';

const offerUrl = '/api/realtime/call?language=en&delay=low';
const offerSdp = 'v=0\r\ns=round14 synthetic offer\r\n';
const answerSdp = 'v=0\r\ns=round14 synthetic answer\r\n';
const realtimeModel = 'gpt-realtime-whisper';
const seed = 'accepted seed';
const unsafeText = 'BAD-INDEX-SPEECH';
const uncertaintyLabel =
  /unconfirmed|uncertain|unsupported|invalid|malformed|conflict|incomplete|unverified|ambiguous|unknown|not (?:verified|confirmed|established)|missing|omitt/i;

let peers: FixturePeer[];
let tracks: Array<{ stop: ReturnType<typeof vi.fn> }>;
let violations: string[];
let offersAllowed: number;
let microphonesAllowed: number;
let peersAllowed: number;
let commitsAllowed: number;
let copiesAllowed: number;
let downloadsAllowed: number;
let expectedDownload: string | null;
let downloaded: Blob[];
let clipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

class FixtureChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  messageListeners: EventListenerOrEventListenerObject[] = [];

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === 'message' && listener) this.messageListeners.push(listener);
    super.addEventListener(type, listener, options);
  }

  send = vi.fn((payload: string) => {
    if (commitsAllowed !== 1) {
      violations.push('Unexpected channel send');
      throw new Error('Unexpected channel send');
    }
    commitsAllowed -= 1;
    const event = JSON.parse(payload) as ServerEvent;
    if (
      event.type !== 'input_audio_buffer.commit' ||
      typeof event.event_id !== 'string' ||
      !event.event_id ||
      event.event_id.length > 512 ||
      Object.keys(event).length !== 2
    ) {
      violations.push('Unexpected client event');
      throw new Error('Unexpected client event');
    }
  });

  close = vi.fn(() => {
    this.readyState = 'closed';
  });

  open() {
    this.readyState = 'open';
    const event = new Event('open');
    this.onopen?.(event);
    this.dispatchEvent(event);
  }

  deliver(payload: ServerEvent) {
    const event = new MessageEvent('message', { data: JSON.stringify(payload) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  captureDelivery() {
    const handler = this.onmessage;
    const listeners = [...this.messageListeners];
    expect(handler !== null || listeners.length > 0).toBe(true);
    return (payload: ServerEvent) => {
      const event = new MessageEvent('message', { data: JSON.stringify(payload) });
      handler?.call(this, event);
      listeners.forEach((listener) => {
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      });
    };
  }
}

class FixturePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: ((event: Event) => void) | null = null;
  channel = new FixtureChannel();
  addTrack = vi.fn();
  createDataChannel = vi.fn((label: string) => {
    if (label !== 'oai-events') {
      violations.push('Unexpected data channel');
      throw new Error('Unexpected data channel');
    }
    return this.channel;
  });
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: offerSdp }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (description.type !== 'answer' || description.sdp !== answerSdp) {
      violations.push('Unexpected remote description');
      throw new Error('Unexpected remote description');
    }
    this.channel.open();
    this.connectionState = 'connected';
    const event = new Event('connectionstatechange');
    this.onconnectionstatechange?.(event);
    this.dispatchEvent(event);
  });
  close = vi.fn(() => {
    this.connectionState = 'closed';
    this.channel.readyState = 'closed';
  });

  constructor() {
    super();
    if (peersAllowed !== 1) {
      violations.push('Unexpected peer');
      throw new Error('Unexpected peer');
    }
    peersAllowed -= 1;
    peers.push(this);
  }
}

function emit(channel: FixtureChannel, event: ServerEvent) {
  act(() => channel.deliver(event));
}

function created(
  itemId: string,
  eventId: string,
  previous: string | null | undefined,
  content: unknown[]
): ServerEvent {
  return {
    type: 'conversation.item.created',
    event_id: eventId,
    ...(previous === undefined ? {} : { previous_item_id: previous }),
    item: { id: itemId, type: 'message', role: 'user', content }
  };
}

function transcription(
  kind: 'partial' | 'final' | 'failed',
  itemId: string,
  eventId: string,
  index: unknown,
  text: string,
  previous?: string | null
): ServerEvent {
  return {
    type: `conversation.item.input_audio_transcription.${
      kind === 'partial' ? 'delta' : kind === 'final' ? 'completed' : 'failed'
    }`,
    event_id: eventId,
    item_id: itemId,
    ...(index === undefined ? {} : { content_index: index }),
    ...(previous === undefined ? {} : { previous_item_id: previous }),
    ...(kind === 'partial' ? { delta: text } : kind === 'final' ? { transcript: text } : {})
  };
}

function displayed() {
  return (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
}

function indexWarning() {
  return Array.from(document.querySelectorAll('.error, [role="alert"], [role="status"]')).some(
    (element) =>
      /\b(?:content|parts?|indexes?|indices|identit(?:y|ies)|unsupported|invalid|malformed|conflict\w*|contradict\w*|inconsisten\w*|mismatch\w*|paus\w*|incomplete|missing|omitt\w*|unverif\w*|ambig\w*)\b|not (?:included|accepted|established)|(?:cannot|unable to) (?:verify|confirm)/i.test(
        element.textContent || ''
      )
  );
}

function strictIndexWarning() {
  return Array.from(document.querySelectorAll('.error, [role="alert"], [role="status"]')).some(
    (element) =>
      /\b(?:content|parts?|indexes?|indices|identit(?:y|ies)|unsupported|invalid|malformed|conflict\w*|contradict\w*|inconsisten\w*|mismatch\w*|paus\w*|missing|omitt\w*|unverif\w*|ambig\w*|unconfirmed|uncertain)\b|not (?:included|accepted|established)|(?:cannot|unable to) (?:verify|confirm)/i.test(
        element.textContent || ''
      )
  );
}

function occurrences(text: string, value: string) {
  return text.split(value).length - 1;
}

function expectBothParts(text: string, first: string, second: string) {
  expect(occurrences(text, first)).toBe(first === second ? 2 : 1);
  if (first !== second) {
    expect(occurrences(text, second)).toBe(1);
    expect(text.indexOf(first)).toBeLessThan(text.indexOf(second));
  }
  expect(text).not.toContain(`${first}${second}`);
}

function exportButtons() {
  return [
    screen.getByRole('button', { name: 'Copy transcript' }),
    screen.getByRole('button', { name: 'TXT' }),
    screen.getByRole('button', { name: 'JSON' })
  ];
}

async function start() {
  offersAllowed += 1;
  microphonesAllowed += 1;
  peersAllowed += 1;
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Listening', undefined, { timeout: 1000 });
  expect([offersAllowed, microphonesAllowed, peersAllowed]).toEqual([0, 0, 0]);
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  return peers[peers.length - 1].channel;
}

function stop(session: number) {
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(tracks[session].stop).toHaveBeenCalledTimes(1);
  expect(peers[session].close).toHaveBeenCalledTimes(1);
}

function acceptSeed(channel: FixtureChannel) {
  emit(channel, transcription('final', 'seed', 'seed-event', 0, seed, null));
  expect(displayed()).toBe(seed);
}

async function download(kind: ExportKind) {
  const position = downloaded.length;
  downloadsAllowed += 1;
  expectedDownload = `transcript.${kind.toLowerCase()}`;
  fireEvent.click(screen.getByRole('button', { name: kind }));
  expect(downloaded).toHaveLength(position + 1);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const timeout = setTimeout(() => {
      reader.abort();
      reject(new Error('Synthetic download read timed out'));
    }, 1000);
    reader.onload = () => {
      clearTimeout(timeout);
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      clearTimeout(timeout);
      reject(reader.error);
    };
    reader.readAsText(downloaded[position]);
  });
}

async function checkExports(requireEnabled: boolean) {
  const current = displayed();
  const [copy, txt, json] = exportButtons();
  if (requireEnabled) [copy, txt, json].forEach((button) => expect(button).toBeEnabled());
  if (!copy.hasAttribute('disabled')) {
    copiesAllowed += 1;
    fireEvent.click(copy);
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(current), { timeout: 1000 });
  }
  if (!txt.hasAttribute('disabled')) {
    expect(await download('TXT')).toBe(`${current}${current.endsWith('\n') ? '' : '\n'}`);
  }
  if (!json.hasAttribute('disabled')) {
    const result = JSON.parse(await download('JSON')) as {
      text: string;
      model?: string;
      segments: unknown[];
    };
    expect(result.text).toBe(current);
    expect(result.segments).toEqual([]);
    if (requireEnabled) expect(result.model).toBe(realtimeModel);
  }
}

function expectUnsupportedPreview() {
  expect(displayed()).toContain(seed);
  expect(strictIndexWarning()).toBe(true);
  if (displayed().includes(unsafeText)) {
    expect(displayed()).not.toContain(`kept${unsafeText}`);
    if (!uncertaintyLabel.test(displayed())) {
      exportButtons().forEach((button) => expect(button).toBeDisabled());
    }
  }
}

async function expectUnsupportedStop() {
  const retained = displayed();
  expect(retained).toContain(seed);
  expect(strictIndexWarning() || uncertaintyLabel.test(retained)).toBe(true);
  if (retained.includes(unsafeText)) {
    expect(retained).not.toContain(`kept${unsafeText}`);
    if (!uncertaintyLabel.test(retained)) {
      exportButtons().forEach((button) => expect(button).toBeDisabled());
    }
  }
  await checkExports(false);
}

beforeEach(() => {
  peers = [];
  tracks = [];
  violations = [];
  offersAllowed = 0;
  microphonesAllowed = 0;
  peersAllowed = 0;
  commitsAllowed = 0;
  copiesAllowed = 0;
  downloadsAllowed = 0;
  expectedDownload = null;
  downloaded = [];
  clipboard = vi.fn<(text: string) => Promise<void>>(async () => {
    if (copiesAllowed !== 1) {
      violations.push('Unexpected clipboard write');
      throw new Error('Unexpected clipboard write');
    }
    copiesAllowed -= 1;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (
        offersAllowed !== 1 ||
        input !== offerUrl ||
        init?.method !== 'POST' ||
        init.body !== offerSdp ||
        new Headers(init.headers).get('Content-Type') !== 'application/sdp' ||
        !init.signal
      ) {
        violations.push('Unexpected fetch');
        return Promise.reject(new Error('Unexpected fetch'));
      }
      offersAllowed -= 1;
      return Promise.resolve(
        new Response(answerSdp, { headers: { 'X-STT-Model': realtimeModel } })
      );
    })
  );
  vi.stubGlobal('RTCPeerConnection', FixturePeer);
  vi.stubGlobal(
    'MediaRecorder',
    class {
      static isTypeSupported() {
        violations.push('Unexpected recorder capability check');
        return false;
      }

      constructor() {
        violations.push('Unexpected recorder');
        throw new Error('Unexpected recorder');
      }
    }
  );
  const syntheticNavigator = Object.create(navigator);
  Object.defineProperties(syntheticNavigator, {
    mediaDevices: {
      value: {
        getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
          if (
            microphonesAllowed !== 1 ||
            constraints.audio !== true ||
            Object.keys(constraints).length !== 1
          ) {
            violations.push('Unexpected microphone request');
            throw new Error('Unexpected microphone request');
          }
          microphonesAllowed -= 1;
          const track = { stop: vi.fn() };
          tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        })
      }
    },
    clipboard: { value: { writeText: clipboard } }
  });
  vi.stubGlobal('navigator', syntheticNavigator);
  const NativeURL = URL;
  vi.stubGlobal(
    'URL',
    Object.assign(class extends NativeURL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        if (downloadsAllowed !== 1) {
          violations.push('Unexpected download');
          throw new Error('Unexpected download');
        }
        downloadsAllowed -= 1;
        downloaded.push(blob);
        return 'blob:round14-synthetic';
      }),
      revokeObjectURL: vi.fn((url: string) => {
        if (url !== 'blob:round14-synthetic') {
          violations.push('Unexpected object URL revocation');
          throw new Error('Unexpected object URL revocation');
        }
      })
    })
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    if (this.href !== 'blob:round14-synthetic' || this.download !== expectedDownload) {
      violations.push('Unexpected download anchor');
      throw new Error('Unexpected download anchor');
    }
    expectedDownload = null;
  });
});

afterEach(() => {
  try {
    cleanup();
    expect(violations).toEqual([]);
    expect([
      offersAllowed,
      microphonesAllowed,
      peersAllowed,
      commitsAllowed,
      copiesAllowed,
      downloadsAllowed
    ]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(expectedDownload).toBeNull();
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
    peers.forEach((peer) => expect(peer.close).toHaveBeenCalledTimes(1));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('content-part identity through the realtime UI', () => {
  it.each(['partial', 'final', 'failed'] as const)(
    'fences a contradictory index-one %s for pending and resolved single-part audio',
    async (kind) => {
      for (const resolved of [false, true]) {
        const view = render(<SttApp />);
        const channel = await start();
        acceptSeed(channel);
        emit(channel, created('target', 'created-target', 'seed', [{ type: 'input_audio' }]));
        emit(
          channel,
          transcription(resolved ? 'final' : 'partial', 'target', 'good-zero', 0, 'kept')
        );
        expect(displayed()).toContain('kept');
        emit(channel, transcription(kind, 'target', 'bad-one', 1, unsafeText));
        expectUnsupportedPreview();
        if (!resolved) emit(channel, transcription('final', 'target', 'good-final', 0, 'kept'));
        expect(displayed()).toContain('kept');
        stop(peers.length - 1);
        await expectUnsupportedStop();
        view.unmount();
      }
    }
  );

  it.each([
    ['null', null],
    ['negative', -1],
    ['fraction', 0.5],
    ['string', '0'],
    ['object', { index: 0 }],
    ['array', [0]],
    ['boolean', false]
  ])('does not interpret a present malformed %s index as legacy absence', async (_name, index) => {
    for (const kind of ['partial', 'final', 'failed'] as const) {
      const view = render(<SttApp />);
      const channel = await start();
      acceptSeed(channel);
      emit(channel, created('target', 'created-target', 'seed', [{ type: 'input_audio' }]));
      emit(channel, transcription('partial', 'target', 'good-zero', 0, 'kept'));
      emit(channel, transcription(kind, 'target', `malformed-${kind}`, index, unsafeText));
      expectUnsupportedPreview();
      expect(displayed()).toContain('kept');
      stop(peers.length - 1);
      await expectUnsupportedStop();
      view.unmount();
    }
  });

  it.each(['partial', 'final', 'failed'] as const)(
    'reconciles late single-part metadata against an earlier index-one %s',
    async (kind) => {
      render(<SttApp />);
      const channel = await start();
      acceptSeed(channel);
      emit(channel, transcription(kind, 'target', 'early-one', 1, unsafeText, 'seed'));
      const previouslyVisible = displayed().includes(unsafeText);
      emit(channel, created('target', 'late-created', 'seed', [{ type: 'input_audio' }]));
      expectUnsupportedPreview();
      if (previouslyVisible) expect(displayed()).toContain(unsafeText);
      stop(0);
      if (previouslyVisible) expect(displayed()).toContain(unsafeText);
      await expectUnsupportedStop();
    }
  );

  it.each([
    ['equal', 'same speech', 'same speech'],
    ['unequal', 'first part', 'second part']
  ])(
    'preserves or explicitly fences %s multi-audio finals with early and late metadata',
    async (_name, first, second) => {
      for (const earlyMetadata of [true, false]) {
        for (const pending of [true, false]) {
          const view = render(<SttApp />);
          const channel = await start();
          acceptSeed(channel);
          const parts = [{ type: 'input_audio' }, { type: 'input_audio' }];
          if (earlyMetadata) {
            emit(channel, created('target', 'early-created', pending ? undefined : 'seed', parts));
          }
          emit(
            channel,
            transcription('final', 'target', 'final-zero', 0, first, pending ? undefined : 'seed')
          );
          const firstWasVisible = displayed().includes(first);
          emit(
            channel,
            transcription('final', 'target', 'final-one', 1, second, pending ? undefined : 'seed')
          );
          const snapshot = displayed();
          const complete =
            first === second
              ? occurrences(snapshot, first) === 2
              : occurrences(snapshot, first) === 1 && occurrences(snapshot, second) === 1;
          if (complete) expectBothParts(snapshot, first, second);
          if (!complete) expect(indexWarning()).toBe(true);
          if (firstWasVisible) expect(snapshot).toContain(first);
          emit(channel, created('target', 'late-created', 'seed', parts));
          expect(displayed()).toContain(seed);
          if (firstWasVisible) expect(displayed()).toContain(first);
          if (complete) expectBothParts(displayed(), first, second);
          if (!complete) expect(indexWarning()).toBe(true);
          stop(peers.length - 1);
          expect(displayed()).toContain(seed);
          if (firstWasVisible) expect(displayed()).toContain(first);
          if (complete) expectBothParts(displayed(), first, second);
          if (!complete)
            expect(indexWarning() || /unconfirmed|uncertain|incomplete/i.test(displayed())).toBe(
              true
            );
          await checkExports(false);
          view.unmount();
        }
      }
    }
  );

  it('does not silently concatenate index-zero and index-one deltas with no created metadata', async () => {
    render(<SttApp />);
    const channel = await start();
    acceptSeed(channel);
    emit(channel, transcription('partial', 'target', 'delta-zero', 0, 'alpha', 'seed'));
    emit(channel, transcription('partial', 'target', 'delta-one', 1, 'beta', 'seed'));
    expect(displayed()).toContain('alpha');
    expect(displayed()).not.toContain('alphabeta');
    const acceptedBoth = displayed().includes('beta');
    if (!acceptedBoth) expect(indexWarning()).toBe(true);
    emit(channel, transcription('final', 'target', 'final-zero', 0, 'alpha', 'seed'));
    expect(displayed()).toContain('alpha');
    if (acceptedBoth) expect(displayed()).toContain('beta');
    emit(channel, transcription('final', 'target', 'final-one', 1, 'beta', 'seed'));
    if (!displayed().includes('beta')) expect(indexWarning()).toBe(true);
    stop(0);
    expect(displayed()).toContain(seed);
    expect(displayed()).toContain('alpha');
    if (acceptedBoth) expect(displayed()).toContain('beta');
    await checkExports(false);
  });

  it.each([
    ['explicit zero', 0],
    ['legacy absent', undefined]
  ])('retains normal no-reference single audio with %s', async (_name, index) => {
    render(<SttApp />);
    const channel = await start();
    emit(channel, created('target', 'created', null, [{ type: 'input_audio' }]));
    const delta = transcription('partial', 'target', 'delta', index, 'hello ');
    emit(channel, delta);
    emit(channel, delta);
    emit(channel, transcription('partial', 'target', 'delta-two', index, 'world'));
    expect(displayed()).toBe('hello world');
    emit(channel, transcription('final', 'target', 'final', index, 'hello world'));
    expect(displayed()).toBe('hello world');
    expect(indexWarning()).toBe(false);
    await checkExports(true);
    stop(0);
    await checkExports(true);
  });

  it('holds a reference until a matching completion confirms it exactly once', async () => {
    render(<SttApp />);
    const channel = await start();
    acceptSeed(channel);
    emit(
      channel,
      created('target', 'reference', 'seed', [
        { type: 'input_audio', transcript: 'confirmed speech' }
      ])
    );
    expect(displayed()).toBe(seed);
    exportButtons().forEach((button) => expect(button).toBeDisabled());
    emit(channel, transcription('final', 'target', 'matching-final', 0, 'confirmed speech'));
    expect(displayed()).toBe(`${seed} confirmed speech`);
    await checkExports(true);
    stop(0);
    await checkExports(true);
  });

  it('keeps equal text across real item IDs and reconciles neutral late metadata', async () => {
    render(<SttApp />);
    const channel = await start();
    emit(channel, transcription('final', 'second', 'final-second', 0, 'same speech'));
    emit(channel, transcription('final', 'first', 'final-first', 0, 'same speech'));
    exportButtons().forEach((button) => expect(button).toBeDisabled());
    emit(channel, {
      type: 'conversation.item.created',
      event_id: 'unknown-second',
      previous_item_id: 'first',
      item: {
        id: 'second',
        type: 'future_kind',
        role: 'future_role',
        content: [{ type: 'future_part' }]
      }
    });
    emit(channel, created('first', 'created-first', null, [{ type: 'input_audio' }]));
    expect(displayed()).toBe('same speech same speech');
    await checkExports(true);
    stop(0);
    await checkExports(true);
  });

  it('deduplicates exact events and rejects an ID reused for a different index', async () => {
    render(<SttApp />);
    const channel = await start();
    const original = transcription('final', 'item', 'same-id', 0, 'accepted', null);
    emit(channel, original);
    emit(channel, original);
    expect(displayed()).toBe('accepted');
    emit(channel, transcription('final', 'item', 'same-id', 1, 'accepted', null));
    expect(strictIndexWarning()).toBe(true);
    expect(displayed()).toBe('accepted');
    stop(0);
    await checkExports(false);
  });

  it('keeps old channel callbacks from changing a new session or releasing its pending turn', async () => {
    render(<SttApp />);
    const oldChannel = await start();
    const staleDelivery = oldChannel.captureDelivery();
    emit(oldChannel, transcription('final', 'old', 'old-final', 0, 'old speech', null));
    stop(0);
    const channel = await start();
    emit(channel, transcription('final', 'new', 'new-final', 0, 'new speech', null));
    commitsAllowed += 1;
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    act(() => staleDelivery(transcription('final', 'new', 'stale-bad', 1, unsafeText, null)));
    act(() =>
      staleDelivery({
        type: 'input_audio_buffer.committed',
        event_id: 'stale-ack',
        item_id: 'stale-item'
      })
    );
    expect(displayed()).toBe('old speech new speech');
    expect(tracks[1].stop).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    const ack = {
      type: 'input_audio_buffer.committed',
      event_id: 'ack-one',
      item_id: 'ack-item-one'
    };
    emit(channel, ack);
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    commitsAllowed += 1;
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    emit(channel, ack);
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'ack-two',
      item_id: 'ack-item-two'
    });
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    expect(channel.send).toHaveBeenCalledTimes(2);
    const firstCommit = JSON.parse(channel.send.mock.calls[0][0]) as ServerEvent;
    const secondCommit = JSON.parse(channel.send.mock.calls[1][0]) as ServerEvent;
    expect(firstCommit.event_id).not.toBe(secondCommit.event_id);
    stop(1);
    expect(displayed()).toBe('old speech new speech');
    await checkExports(true);
  });

  it('retains accepted speech after a bounded event-ID rejection', async () => {
    render(<SttApp />);
    const channel = await start();
    acceptSeed(channel);
    emit(channel, transcription('final', 'target', 'x'.repeat(257), 1, unsafeText, 'seed'));
    expect(strictIndexWarning()).toBe(true);
    expect(displayed()).toBe(seed);
    stop(0);
    await checkExports(true);
  });
});
