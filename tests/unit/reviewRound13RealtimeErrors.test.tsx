import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type RealtimeEvent = Record<string, unknown>;
type ClientCommit = { type: string; event_id: string };

const offerUrl = '/api/realtime/call?language=en&delay=low';
const offerSdp = 'v=0\r\ns=synthetic offer\r\n';
const answerSdp = 'v=0\r\ns=synthetic answer\r\n';
const model = 'gpt-realtime-whisper';
const privateMarker = 'PRIVATE_PROVIDER_FIELD_ROUND13';

let peers: SyntheticPeer[];
let ownedTracks: Array<Array<{ stop: ReturnType<typeof vi.fn> }>>;
let unrelatedTrack: { stop: ReturnType<typeof vi.fn> };
let downloads: Blob[];
let exportedPayloads: string[];
let violations: string[];
let allowedOffers: number;
let allowedMicrophones: number;
let allowedPeers: number;
let allowedCommits: number;
let allowedCopies: number;
let allowedDownloads: number;
let expectedDownload: string | null;
let clipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let logs: Array<{ mock: { calls: unknown[][] } }>;

class SyntheticChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  messageListeners: EventListenerOrEventListenerObject[] = [];
  close = vi.fn(() => {
    this.readyState = 'closed';
  });
  send = vi.fn((data: string) => {
    if (allowedCommits !== 1) {
      violations.push('Unexpected data-channel send');
      throw new Error('Unexpected data-channel send');
    }
    allowedCommits -= 1;
    const value = JSON.parse(data) as RealtimeEvent;
    if (
      value.type !== 'input_audio_buffer.commit' ||
      typeof value.event_id !== 'string' ||
      !value.event_id ||
      value.event_id.length > 512 ||
      Object.keys(value).length !== 2
    ) {
      violations.push('Unexpected client event');
      throw new Error('Unexpected client event');
    }
  });

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === 'message' && listener) this.messageListeners.push(listener);
    super.addEventListener(type, listener, options);
  }

  open() {
    this.readyState = 'open';
    const event = new Event('open');
    this.onopen?.(event);
    this.dispatchEvent(event);
  }

  deliver(payload: RealtimeEvent) {
    const event = new MessageEvent('message', { data: JSON.stringify(payload) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  savedDelivery() {
    const handler = this.onmessage;
    const listeners = [...this.messageListeners];
    expect(handler !== null || listeners.length > 0).toBe(true);
    return (payload: RealtimeEvent) => {
      const event = new MessageEvent('message', { data: JSON.stringify(payload) });
      handler?.call(this, event);
      listeners.forEach((listener) => {
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      });
    };
  }
}

class SyntheticPeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: ((event: Event) => void) | null = null;
  channel = new SyntheticChannel();
  addTrack = vi.fn();
  createDataChannel = vi.fn((label: string) => {
    if (label !== 'oai-events') {
      violations.push('Unexpected channel');
      throw new Error('Unexpected channel');
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
    if (allowedPeers !== 1) {
      violations.push('Unexpected peer');
      throw new Error('Unexpected peer');
    }
    allowedPeers -= 1;
    peers.push(this);
  }
}

function emit(channel: SyntheticChannel, payload: RealtimeEvent) {
  act(() => channel.deliver(payload));
}

function final(itemId: string, eventId: string, value: string, previous: string | null) {
  return {
    type: 'conversation.item.input_audio_transcription.completed',
    event_id: eventId,
    item_id: itemId,
    previous_item_id: previous,
    content_index: 0,
    transcript: value
  };
}

function acknowledged(itemId: string, eventId: string, previous: string | null) {
  return {
    type: 'input_audio_buffer.committed',
    event_id: eventId,
    item_id: itemId,
    previous_item_id: previous
  };
}

function serverError(eventId: string, suffix: string, nestedClientId?: string) {
  return {
    type: 'error',
    event_id: eventId,
    error: {
      message: `${privateMarker}_message_${suffix}`,
      code: `${privateMarker}_code_${suffix}`,
      type: `${privateMarker}_type_${suffix}`,
      ...(nestedClientId === undefined ? {} : { event_id: nestedClientId })
    }
  };
}

function text() {
  return (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
}

function notices() {
  return Array.from(document.querySelectorAll('.error, [role="alert"], [role="status"]'))
    .map((element) => element.textContent || '')
    .filter(Boolean);
}

function errorNotice() {
  const visibleNotices = notices();
  const notice = visibleNotices.find((value) =>
    /error|problem|issue|warning|difficulty/i.test(value)
  );
  expect(notice).toBeDefined();
  expect(
    visibleNotices.some((value) => /stop|retry|try again|restart|start again/i.test(value))
  ).toBe(true);
  return notice as string;
}

function correlatedNotice() {
  const visibleNotices = notices();
  const notice = visibleNotices.find((value) => /turn|audio|commit/i.test(value));
  expect(notice).toBeDefined();
  expect(
    visibleNotices.some((value) => /stop|retry|try again|restart|start again/i.test(value))
  ).toBe(true);
  return notice as string;
}

function expectNoFailureClaim(notice: string) {
  expect(notice).not.toMatch(
    /\b(?:turn|commit|transcription|session|audio)\s+(?:has\s+)?(?:failed|was rejected|was not accepted|was lost)\b/i
  );
}

function logText() {
  return logs
    .flatMap((log) => log.mock.calls)
    .map((call) =>
      call
        .map((value: unknown) => {
          if (typeof value === 'string') return value;
          try {
            return JSON.stringify(value) || '';
          } catch {
            return String(value);
          }
        })
        .join(' ')
    )
    .join('\n');
}

function expectPrivateFieldsAbsent() {
  expect(document.documentElement.textContent || '').not.toContain(privateMarker);
  expect(text()).not.toContain(privateMarker);
  expect(logText()).not.toContain(privateMarker);
  expect(JSON.stringify(clipboard.mock.calls)).not.toContain(privateMarker);
  exportedPayloads.forEach((payload) => expect(payload).not.toContain(privateMarker));
}

async function startLive() {
  allowedOffers += 1;
  allowedMicrophones += 1;
  allowedPeers += 1;
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Listening', undefined, { timeout: 1000 });
  expect(allowedOffers).toBe(0);
  expect(allowedMicrophones).toBe(0);
  expect(allowedPeers).toBe(0);
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  return peers[peers.length - 1].channel;
}

function finishTurn(channel: SyntheticChannel) {
  const count = channel.send.mock.calls.length;
  expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
  allowedCommits += 1;
  fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
  expect(channel.send).toHaveBeenCalledTimes(count + 1);
  const commit = JSON.parse(channel.send.mock.calls[count][0]) as ClientCommit;
  expect(commit.type).toBe('input_audio_buffer.commit');
  expect(commit.event_id.length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
  return commit;
}

function expectPending(channel: SyntheticChannel, count: number) {
  const button = screen.getByRole('button', { name: 'Finish turn' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(channel.send).toHaveBeenCalledTimes(count);
}

function stopLive(index: number) {
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  ownedTracks[index].forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
  expect(peers[index].close).toHaveBeenCalledTimes(1);
  expect(unrelatedTrack.stop).not.toHaveBeenCalled();
}

async function readDownload(format: 'TXT' | 'JSON') {
  const button = screen.getByRole('button', { name: format });
  expect(button).toBeEnabled();
  const count = downloads.length;
  allowedDownloads += 1;
  expectedDownload = `transcript.${format.toLowerCase()}`;
  fireEvent.click(button);
  expect(downloads).toHaveLength(count + 1);
  const result = await new Promise<string>((resolve, reject) => {
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
    reader.readAsText(downloads[count]);
  });
  exportedPayloads.push(result);
  return result;
}

async function expectExports(expected: string) {
  expect(text()).toBe(expected);
  const copy = screen.getByRole('button', { name: 'Copy transcript' });
  expect(copy).toBeEnabled();
  allowedCopies += 1;
  fireEvent.click(copy);
  await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(expected), { timeout: 1000 });
  expect(await readDownload('TXT')).toBe(`${expected}\n`);
  const json = JSON.parse(await readDownload('JSON')) as {
    text: string;
    model?: string;
    segments: unknown[];
  };
  expect(json.text).toBe(expected);
  expect(json.model).toBe(model);
  expect(json.segments).toEqual([]);
  expectPrivateFieldsAbsent();
}

beforeEach(() => {
  peers = [];
  ownedTracks = [];
  unrelatedTrack = { stop: vi.fn() };
  downloads = [];
  exportedPayloads = [];
  violations = [];
  allowedOffers = 0;
  allowedMicrophones = 0;
  allowedPeers = 0;
  allowedCommits = 0;
  allowedCopies = 0;
  allowedDownloads = 0;
  expectedDownload = null;
  logs = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  ];
  clipboard = vi.fn<(value: string) => Promise<void>>(async () => {
    if (allowedCopies !== 1) {
      violations.push('Unexpected clipboard write');
      throw new Error('Unexpected clipboard write');
    }
    allowedCopies -= 1;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (
        allowedOffers !== 1 ||
        input !== offerUrl ||
        init?.method !== 'POST' ||
        init.body !== offerSdp ||
        new Headers(init.headers).get('Content-Type') !== 'application/sdp' ||
        !init.signal
      ) {
        violations.push('Unexpected fetch');
        return Promise.reject(new Error('Unexpected fetch'));
      }
      allowedOffers -= 1;
      return Promise.resolve(new Response(answerSdp, { headers: { 'X-STT-Model': model } }));
    })
  );
  vi.stubGlobal('RTCPeerConnection', SyntheticPeer);
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
  const navigatorFixture = Object.create(navigator);
  Object.defineProperties(navigatorFixture, {
    mediaDevices: {
      value: {
        getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
          if (
            allowedMicrophones !== 1 ||
            constraints.audio !== true ||
            Object.keys(constraints).length !== 1
          ) {
            violations.push('Unexpected microphone request');
            throw new Error('Unexpected microphone request');
          }
          allowedMicrophones -= 1;
          const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
          ownedTracks.push(tracks);
          return { getTracks: () => tracks, getAudioTracks: () => tracks };
        })
      }
    },
    clipboard: { value: { writeText: clipboard } }
  });
  vi.stubGlobal('navigator', navigatorFixture);
  const NativeURL = URL;
  vi.stubGlobal(
    'URL',
    Object.assign(class extends NativeURL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        if (allowedDownloads !== 1) {
          violations.push('Unexpected download');
          throw new Error('Unexpected download');
        }
        allowedDownloads -= 1;
        downloads.push(blob);
        return 'blob:synthetic-download';
      }),
      revokeObjectURL: vi.fn()
    })
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    if (this.href !== 'blob:synthetic-download' || this.download !== expectedDownload) {
      violations.push('Unexpected download anchor');
      throw new Error('Unexpected download anchor');
    }
    expectedDownload = null;
  });
});

afterEach(() => {
  try {
    cleanup();
    expect(logText()).not.toContain(privateMarker);
    expect(violations).toEqual([]);
    expect([
      allowedOffers,
      allowedMicrophones,
      allowedPeers,
      allowedCommits,
      allowedCopies,
      allowedDownloads
    ]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(expectedDownload).toBeNull();
    ownedTracks.flat().forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
    expect(unrelatedTrack.stop).not.toHaveBeenCalled();
    peers.forEach((peer) => expect(peer.close).toHaveBeenCalledTimes(1));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('realtime server errors in the public UI', () => {
  it('warns and offers recovery for an error immediately after connecting', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, serverError(`${privateMarker}_server_before_speech`, 'before-speech'));
    expectNoFailureClaim(errorNotice());
    expect(text()).toBe('');
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    expectPrivateFieldsAbsent();
    stopLive(0);
    expect(text()).toBe('');
  });

  it.each(['before first Finish', 'after identified ACK'] as const)(
    'shows fixed safe recovery with no pending turn %s',
    async (phase) => {
      render(<SttApp />);
      const channel = await startLive();
      emit(channel, final('seed', 'seed-final', 'accepted speech', null));
      let previousClientId: string | undefined;
      if (phase === 'after identified ACK') {
        previousClientId = finishTurn(channel).event_id;
        emit(channel, acknowledged('turn', 'turn-ack', 'seed'));
        expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
      }
      const first = serverError(`${privateMarker}_server_one`, 'one');
      emit(channel, first);
      const warning = errorNotice();
      expectNoFailureClaim(warning);
      expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
      emit(
        channel,
        serverError(`${privateMarker}_server_two`, 'two', `${privateMarker}_unrelated_client`)
      );
      expect(errorNotice()).toBe(warning);
      expectNoFailureClaim(errorNotice());
      if (previousClientId) {
        emit(channel, serverError(`${privateMarker}_server_three`, 'three', previousClientId));
        expect(errorNotice()).toBe(warning);
        expectNoFailureClaim(errorNotice());
      }
      expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
      expectPrivateFieldsAbsent();
      await expectExports('accepted speech');
      stopLive(0);
      await expectExports('accepted speech');
    }
  );

  it.each(['missing nested ID', 'unrelated nested ID', 'outer ID equals client ID'] as const)(
    'keeps a pending turn on an uncorrelated error: %s',
    async (kind) => {
      render(<SttApp />);
      const channel = await startLive();
      emit(channel, final('seed', 'seed-final', 'accepted speech', null));
      const pending = finishTurn(channel);
      const outerId =
        kind === 'outer ID equals client ID' ? pending.event_id : `${privateMarker}_server_error`;
      const nestedId =
        kind === 'missing nested ID' ? undefined : `${privateMarker}_unrelated_client`;
      emit(channel, serverError(outerId, kind, nestedId));
      expectPending(channel, 1);
      const warning = errorNotice();
      expect(warning).toMatch(
        /unknown|uncertain|unconfirmed|cannot (?:be )?(?:known|verified)|not (?:yet )?(?:known|clear|confirmed|verified)|may (?:or may not|not) (?:have|be)/i
      );
      expectNoFailureClaim(warning);
      expectPrivateFieldsAbsent();
      emit(channel, acknowledged('turn', 'identified-ack', 'seed'));
      expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
      emit(channel, final('turn', 'turn-final', 'additional speech', 'seed'));
      await expectExports('accepted speech additional speech');
      stopLive(0);
      await expectExports('accepted speech additional speech');
    }
  );

  it('handles matching nested correlation but never replays its duplicate into a later turn', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, final('seed', 'seed-final', 'accepted speech', null));
    const first = finishTurn(channel);
    const error = serverError(`${privateMarker}_matching_server`, 'matching', first.event_id);
    emit(channel, error);
    const warning = correlatedNotice();
    expect(warning).toMatch(/turn|audio|commit/i);
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    const second = finishTurn(channel);
    expect(second.event_id).not.toBe(first.event_id);
    const beforeDuplicate = notices();
    emit(channel, error);
    expectPending(channel, 2);
    expect(notices()).toEqual(beforeDuplicate);
    emit(channel, acknowledged('turn', 'identified-ack', 'seed'));
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    expectPrivateFieldsAbsent();
    stopLive(0);
    await expectExports('accepted speech');
  });

  it('ignores retired errors before and during a replacement pending turn', async () => {
    render(<SttApp />);
    const oldChannel = await startLive();
    const staleDelivery = oldChannel.savedDelivery();
    emit(oldChannel, final('old', 'old-final', 'earlier speech', null));
    emit(oldChannel, serverError(`${privateMarker}_old_server`, 'old'));
    expectNoFailureClaim(errorNotice());
    stopLive(0);
    const channel = await startLive();
    emit(channel, final('new', 'new-final', 'new speech', null));
    const initialNotices = notices();
    act(() => staleDelivery(serverError(`${privateMarker}_stale_before`, 'stale-before')));
    expect(notices()).toEqual(initialNotices);
    const pending = finishTurn(channel);
    const pendingNotices = notices();
    act(() =>
      staleDelivery(
        serverError(`${privateMarker}_stale_matching`, 'stale-pending', pending.event_id)
      )
    );
    expect(notices()).toEqual(pendingNotices);
    expectPending(channel, 1);
    ownedTracks[1].forEach((track) => expect(track.stop).not.toHaveBeenCalled());
    expect(unrelatedTrack.stop).not.toHaveBeenCalled();
    emit(channel, acknowledged('new-turn', 'new-ack', 'new'));
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    await expectExports('earlier speech new speech');
    stopLive(1);
    await expectExports('earlier speech new speech');
  });
});
