import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type RealtimeEvent = Record<string, unknown>;

const offerUrl = '/api/realtime/call?language=en&delay=low';
const offerSdp = 'v=0\r\ns=synthetic offer\r\n';
const answerSdp = 'v=0\r\ns=synthetic answer\r\n';
const model = 'gpt-realtime-whisper';

let peers: SyntheticPeer[];
let tracks: Array<{ stop: ReturnType<typeof vi.fn> }>;
let downloads: Blob[];
let violations: string[];
let allowedOffers: number;
let allowedMicrophones: number;
let allowedPeers: number;
let allowedCommits: number;
let allowedCopies: number;
let allowedDownloads: number;
let expectedDownload: string | null;
let clipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

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

  deliver(data: string) {
    const event = new MessageEvent('message', { data });
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
  act(() => channel.deliver(JSON.stringify(payload)));
}

function created(
  itemId: string,
  eventId: string,
  previous: string | null,
  reference?: string
): RealtimeEvent {
  return {
    type: 'conversation.item.created',
    event_id: eventId,
    previous_item_id: previous,
    item: {
      id: itemId,
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_audio', ...(reference === undefined ? {} : { transcript: reference }) }
      ]
    }
  };
}

function final(itemId: string, eventId: string, text: string, previous?: string | null) {
  return {
    type: 'conversation.item.input_audio_transcription.completed',
    event_id: eventId,
    item_id: itemId,
    content_index: 0,
    transcript: text,
    ...(previous === undefined ? {} : { previous_item_id: previous })
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

function expectSafetyNotice() {
  expect(
    notices().some((notice) =>
      /unconfirmed|uncertain|unknown|pending|conflict|mismatch|unsupported|paus|invalid|limit|malformed|too large|confirm|verif/i.test(
        notice
      )
    )
  ).toBe(true);
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

function stopLive(trackIndex: number) {
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(tracks[trackIndex].stop).toHaveBeenCalledTimes(1);
  expect(peers[trackIndex].close).toHaveBeenCalledTimes(1);
}

async function readDownload(format: 'TXT' | 'JSON') {
  const button = screen.getByRole('button', { name: format });
  expect(button).toBeEnabled();
  const count = downloads.length;
  allowedDownloads += 1;
  expectedDownload = `transcript.${format.toLowerCase()}`;
  fireEvent.click(button);
  expect(downloads).toHaveLength(count + 1);
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
    reader.readAsText(downloads[count]);
  });
}

async function expectExports(expected: string) {
  expect(text()).toBe(expected);
  const copy = screen.getByRole('button', { name: 'Copy transcript' });
  expect(copy).toBeEnabled();
  allowedCopies += 1;
  fireEvent.click(copy);
  await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(expected), { timeout: 1000 });
  expect(await readDownload('TXT')).toBe(`${expected}${expected.endsWith('\n') ? '' : '\n'}`);
  const json = JSON.parse(await readDownload('JSON')) as {
    text: string;
    model?: string;
    segments: unknown[];
  };
  expect(json.text).toBe(expected);
  expect(json.model).toBe(model);
  expect(json.segments).toEqual([]);
  expect(screen.getByRole('button', { name: 'SRT' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'VTT' })).toBeDisabled();
}

beforeEach(() => {
  peers = [];
  tracks = [];
  downloads = [];
  violations = [];
  allowedOffers = 0;
  allowedMicrophones = 0;
  allowedPeers = 0;
  allowedCommits = 0;
  allowedCopies = 0;
  allowedDownloads = 0;
  expectedDownload = null;
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
          const track = { stop: vi.fn() };
          tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
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
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalledTimes(1));
    peers.forEach((peer) => expect(peer.close).toHaveBeenCalledTimes(1));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('created-item metadata in the public realtime UI', () => {
  it('reconciles the four late-order events and matching reference without duplicate speech', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const completedB = final('B', 'completed-B', 'second');
    emit(channel, completedB);
    emit(channel, completedB);
    emit(channel, final('A', 'completed-A', 'first'));
    const createdB = created('B', 'created-B', 'A', 'second');
    emit(channel, createdB);
    expect(text()).toBe('first second');
    expect(screen.getByRole('button', { name: 'TXT' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeDisabled();
    emit(channel, createdB);
    emit(channel, created('B', 'created-B-distinct', 'A', 'second'));
    emit(channel, created('A', 'created-A', null));
    await expectExports('first second');
    expect(channel.send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    stopLive(0);
    await expectExports('first second');
  });

  it('accepts audio metadata before a final and permits neutral unknown metadata', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, created('A', 'created-A', null));
    emit(channel, final('A', 'final-A', 'first'));
    emit(channel, {
      type: 'conversation.item.created',
      event_id: 'created-B',
      previous_item_id: 'A',
      item: {
        id: 'B',
        type: 'future_kind',
        role: 'future_role',
        content: [{ type: 'future_part' }]
      }
    });
    emit(channel, final('B', 'final-B', 'second'));
    await expectExports('first second');
    stopLive(0);
    await expectExports('first second');
  });

  it('does not accept a conflicting reference as speech or lose an accepted final', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, final('A', 'final-A', 'accepted speech', null));
    emit(channel, created('A', 'created-A', null, 'contradictory reference'));
    expectSafetyNotice();
    expect(text()).toContain('accepted speech');
    expect(text()).not.toContain('contradictory reference');
    stopLive(0);
    const retained = text();
    expect(retained).toContain('accepted speech');
    expect(retained).not.toContain('contradictory reference');
    await expectExports(retained);
  });

  it('does not use a matching second content part to hide a conflicting first part', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, final('A', 'final-A', 'accepted speech', null));
    emit(channel, {
      type: 'conversation.item.created',
      event_id: 'created-A',
      previous_item_id: null,
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_audio', transcript: 'contradictory reference' },
          { type: 'input_audio', transcript: 'accepted speech' }
        ]
      }
    });
    expectSafetyNotice();
    expect(text()).toContain('accepted speech');
    expect(text()).not.toContain('contradictory reference');
    stopLive(0);
    const retained = text();
    expect(retained).toContain('accepted speech');
    expect(retained).not.toContain('contradictory reference');
    await expectExports(retained);
  });

  it.each([false, true])(
    'handles an unconfirmed created reference safely (matching final arrives: %s)',
    async (complete) => {
      render(<SttApp />);
      const channel = await startLive();
      emit(channel, final('A', 'final-A', 'accepted speech', null));
      emit(channel, created('B', 'created-B', 'A', 'reference speech'));
      expectSafetyNotice();
      if (text().includes('reference speech')) {
        expect(screen.getByRole('button', { name: 'TXT' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeDisabled();
      }
      if (complete) emit(channel, final('B', 'final-B', 'reference speech'));
      const confirmed = complete && text() === 'accepted speech reference speech';
      if (confirmed) {
        await expectExports('accepted speech reference speech');
      } else {
        expectSafetyNotice();
      }
      stopLive(0);
      const retained = text();
      expect(retained).toContain('accepted speech');
      if (!confirmed && retained.includes('reference speech')) {
        expect(retained).toMatch(/unconfirmed|uncertain|unknown/i);
      }
      await expectExports(retained);
    }
  );

  it('fences conflicting reuse of a created event ID without dropping accepted text', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, final('A', 'final-A', 'accepted speech', null));
    emit(channel, created('A', 'same-id', null, 'accepted speech'));
    emit(channel, created('A', 'same-id', null, 'changed reference'));
    expectSafetyNotice();
    emit(channel, final('B', 'later-final', 'must not appear', 'A'));
    expect(text()).toBe('accepted speech');
    stopLive(0);
    await expectExports('accepted speech');
  });

  it('ignores retired-channel messages while a new session owns capture and turn control', async () => {
    render(<SttApp />);
    const oldChannel = await startLive();
    const staleDelivery = oldChannel.savedDelivery();
    emit(oldChannel, final('A', 'old-final', 'earlier speech', null));
    stopLive(0);
    const channel = await startLive();
    act(() => staleDelivery(created('A', 'old-created', null, 'incorrect stale speech')));
    act(() => staleDelivery(final('B', 'old-late-final', 'incorrect stale speech', 'A')));
    expect(text()).toBe('earlier speech');
    expect(tracks[1].stop).not.toHaveBeenCalled();
    emit(channel, final('new', 'new-final', 'new speech', null));
    await expectExports('earlier speech new speech');
    allowedCommits += 1;
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    stopLive(1);
    await expectExports('earlier speech new speech');
  });

  it.each(['oversized event ID', 'oversized message'] as const)(
    'stops acceptance at the %s bound and still promptly stops and exports accepted text',
    async (kind) => {
      render(<SttApp />);
      const channel = await startLive();
      emit(channel, final('A', 'final-A', 'accepted speech', null));
      if (kind === 'oversized event ID') {
        emit(channel, created('A', 'x'.repeat(257), null, 'accepted speech'));
      } else {
        act(() => channel.deliver('x'.repeat(1_100_001)));
      }
      expectSafetyNotice();
      emit(channel, final('B', 'later-final', 'must not appear', 'A'));
      expect(text()).toBe('accepted speech');
      stopLive(0);
      await expectExports('accepted speech');
    }
  );
});
