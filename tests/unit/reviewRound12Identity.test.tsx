import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';
import type { TranscriptDocument } from '@/src/lib/transcriptExport';

type ServerEvent = Record<string, unknown>;
type CreatedItem = Record<string, unknown>;

const offerUrl = '/api/realtime/call?language=en&delay=low';
const realtimeModel = 'gpt-realtime-whisper';
const offerSdp = 'v=0\r\ns=synthetic offer\r\n';
const answerSdp = 'v=0\r\ns=synthetic answer\r\n';
const seedText = 'Accepted seed';

let peers: TestPeer[];
let stopTracks: ReturnType<typeof vi.fn>[];
let requestedOffers: number;
let allowedMicrophones: number;
let allowedClipboardWrites: number;
let allowedDownloads: number;
let expectedAnchorDownload: string | null;
let blobs: Blob[];
let unexpected: string[];
let clipboard: ReturnType<typeof vi.fn<(value: string) => Promise<void>>>;

class TestChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  messageListeners: EventListenerOrEventListenerObject[] = [];
  send = vi.fn(() => {
    unexpected.push('Unexpected data-channel send');
    throw new Error('Unexpected data-channel send');
  });
  close = vi.fn(() => {
    this.readyState = 'closed';
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

  emit(data: ServerEvent) {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  savedDelivery() {
    const handler = this.onmessage;
    const listeners = [...this.messageListeners];
    expect(handler !== null || listeners.length > 0).toBe(true);
    return (data: ServerEvent) => {
      const event = new MessageEvent('message', { data: JSON.stringify(data) });
      handler?.call(this, event);
      listeners.forEach((listener) => {
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      });
    };
  }
}

class TestPeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: ((event: Event) => void) | null = null;
  channel = new TestChannel();
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: offerSdp }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => {
    this.channel.open();
    this.connectionState = 'connected';
    const event = new Event('connectionstatechange');
    this.onconnectionstatechange?.(event);
    this.dispatchEvent(event);
  });
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });

  constructor() {
    super();
    peers.push(this);
  }
}

function emit(channel: TestChannel, event: ServerEvent) {
  act(() => channel.emit(event));
}

function displayedText() {
  return (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
}

function created(item: CreatedItem, eventId = 'created-target'): ServerEvent {
  return {
    type: 'conversation.item.created',
    event_id: eventId,
    previous_item_id: 'seed',
    item: { id: 'target', ...item }
  };
}

function ack(itemId: string, eventId: string, previous: string | null): ServerEvent {
  return {
    type: 'input_audio_buffer.committed',
    event_id: eventId,
    item_id: itemId,
    previous_item_id: previous
  };
}

function final(itemId: string, eventId: string, text: string): ServerEvent {
  return {
    type: 'conversation.item.input_audio_transcription.completed',
    event_id: eventId,
    item_id: itemId,
    transcript: text
  };
}

async function startLive() {
  requestedOffers += 1;
  allowedMicrophones += 1;
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Listening');
  return peers[peers.length - 1].channel;
}

function seed(channel: TestChannel) {
  emit(channel, ack('seed', 'ack-seed', null));
  emit(channel, final('seed', 'final-seed', seedText));
  expect(displayedText()).toBe(seedText);
}

function expectFence() {
  expect(
    screen
      .getAllByRole('alert')
      .some((element) => /paused|conflict|invalid|malformed|limit/i.test(element.textContent || ''))
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
}

async function download(name: 'TXT' | 'JSON') {
  const count = blobs.length;
  const button = screen.getByRole('button', { name });
  expect(button).toBeEnabled();
  allowedDownloads += 1;
  expectedAnchorDownload = `transcript.${name.toLowerCase()}`;
  fireEvent.click(button);
  expect(blobs).toHaveLength(count + 1);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blobs[count]);
  });
}

async function expectSafeExports(expectedText: string) {
  expect(displayedText()).toBe(expectedText);
  const copy = screen.getByRole('button', { name: 'Copy transcript' });
  expect(copy).toBeEnabled();
  allowedClipboardWrites += 1;
  fireEvent.click(copy);
  await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(expectedText));
  expect(await download('TXT')).toBe(`${expectedText}\n`);
  const exported = JSON.parse(await download('JSON')) as TranscriptDocument;
  expect(exported.text).toBe(expectedText);
  expect(exported.model).toBe(realtimeModel);
  expect(exported.segments).toEqual([]);
  expect(screen.getByRole('button', { name: 'SRT' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'VTT' })).toBeDisabled();
}

const nonAudioItems: { label: string; item: CreatedItem }[] = [
  {
    label: 'function call',
    item: { type: 'function_call', call_id: 'call', name: 'fixture', arguments: '{}' }
  },
  {
    label: 'function output',
    item: { type: 'function_call_output', call_id: 'call', output: 'fixture' }
  },
  {
    label: 'MCP approval request',
    item: {
      type: 'mcp_approval_request',
      server_label: 'fixture',
      name: 'tool',
      arguments: '{}'
    }
  },
  {
    label: 'MCP approval response',
    item: { type: 'mcp_approval_response', approval_request_id: 'approval', approve: false }
  },
  {
    label: 'MCP tool list',
    item: { type: 'mcp_list_tools', server_label: 'fixture', tools: [] }
  },
  {
    label: 'MCP tool call',
    item: { type: 'mcp_call', server_label: 'fixture', name: 'tool', arguments: '{}' }
  },
  {
    label: 'user image and unknown companion',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj' }, {}]
    }
  },
  {
    label: 'assistant output audio',
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_audio', audio: 'c3ludGhldGlj', transcript: '' }]
    }
  },
  {
    label: 'user role with output audio',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'output_audio', audio: 'c3ludGhldGlj', transcript: '' }]
    }
  },
  {
    label: 'assistant role with sparse content',
    item: { type: 'message', role: 'assistant', content: [] }
  },
  {
    label: 'system role with sparse content',
    item: { type: 'message', role: 'system', content: [] }
  }
];

beforeEach(() => {
  peers = [];
  stopTracks = [];
  requestedOffers = 0;
  allowedMicrophones = 0;
  allowedClipboardWrites = 0;
  allowedDownloads = 0;
  expectedAnchorDownload = null;
  blobs = [];
  unexpected = [];
  clipboard = vi.fn<(value: string) => Promise<void>>(async () => {
    if (allowedClipboardWrites < 1) {
      unexpected.push('Unexpected clipboard write');
      throw new Error('Unexpected clipboard write');
    }
    allowedClipboardWrites -= 1;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (
        requestedOffers < 1 ||
        url !== offerUrl ||
        init?.method !== 'POST' ||
        init.body !== offerSdp ||
        new Headers(init.headers).get('Content-Type') !== 'application/sdp'
      ) {
        unexpected.push(`Unexpected synthetic request: ${init?.method || 'GET'} ${url}`);
        return Promise.reject(new Error('Unexpected synthetic request'));
      }
      requestedOffers -= 1;
      return Promise.resolve(
        new Response(answerSdp, { headers: { 'X-STT-Model': realtimeModel } })
      );
    })
  );
  vi.stubGlobal('RTCPeerConnection', TestPeer);
  vi.stubGlobal(
    'MediaRecorder',
    class {
      static isTypeSupported() {
        unexpected.push('Unexpected local recorder capability check');
        return false;
      }

      constructor() {
        unexpected.push('Unexpected local recorder');
        throw new Error('Unexpected local recorder');
      }
    }
  );
  const navigatorFixture = Object.create(navigator);
  Object.defineProperties(navigatorFixture, {
    mediaDevices: {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
          if (allowedMicrophones < 1 || constraints.audio !== true) {
            unexpected.push('Unexpected microphone request');
            throw new Error('Unexpected microphone request');
          }
          allowedMicrophones -= 1;
          const stop = vi.fn();
          stopTracks.push(stop);
          const track = { stop };
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        })
      }
    },
    clipboard: { configurable: true, value: { writeText: clipboard } }
  });
  vi.stubGlobal('navigator', navigatorFixture);
  const NativeURL = URL;
  vi.stubGlobal(
    'URL',
    Object.assign(class extends NativeURL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        if (allowedDownloads < 1) {
          unexpected.push('Unexpected download');
          throw new Error('Unexpected download');
        }
        allowedDownloads -= 1;
        blobs.push(blob);
        return 'blob:synthetic-download';
      }),
      revokeObjectURL: vi.fn()
    })
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    if (this.href !== 'blob:synthetic-download' || this.download !== expectedAnchorDownload) {
      unexpected.push('Unexpected anchor download');
      throw new Error('Unexpected anchor download');
    }
    expectedAnchorDownload = null;
  });
});

afterEach(() => {
  try {
    cleanup();
    expect(unexpected).toEqual([]);
    expect(requestedOffers).toBe(0);
    expect(allowedMicrophones).toBe(0);
    expect(allowedClipboardWrites).toBe(0);
    expect(allowedDownloads).toBe(0);
    expect(expectedAnchorDownload).toBeNull();
    expect(stopTracks.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('round 12 public realtime item identity', () => {
  describe.each(nonAudioItems)('$label', ({ item }) => {
    it.each(['non-audio first', 'pending audio first', 'resolved audio first'] as const)(
      'fences the contradiction: %s',
      async (order) => {
        render(<SttApp />);
        const channel = await startLive();
        seed(channel);
        if (order === 'non-audio first') emit(channel, created(item));
        emit(channel, ack('target', 'ack-target', 'seed'));
        if (order === 'resolved audio first') {
          emit(channel, final('target', 'final-target', 'Accepted target'));
        }
        if (order !== 'non-audio first') emit(channel, created(item));
        expectFence();
        const retained =
          order === 'resolved audio first' ? `${seedText} Accepted target` : seedText;
        expect(displayedText()).toBe(retained);
        emit(channel, final('target', 'rejected-final', 'Rejected target'));
        emit(channel, ack('later', 'ack-later', 'target'));
        emit(channel, {
          type: 'conversation.item.input_audio_transcription.delta',
          event_id: 'delta-later',
          item_id: 'later',
          delta: 'Rejected partial speech'
        });
        emit(channel, final('later', 'final-later', 'Rejected later speech'));
        expect(displayedText()).toBe(retained);
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await expectSafeExports(retained);
      }
    );
  });

  it.each([
    {
      label: 'assistant with input audio',
      item: { type: 'message', role: 'assistant', content: [{ type: 'input_audio' }] }
    },
    {
      label: 'system with input audio',
      item: { type: 'message', role: 'system', content: [{ type: 'input_audio' }] }
    },
    {
      label: 'input audio mixed with image and unknown content',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio' }, { type: 'input_image' }, { type: 'future_part' }]
      }
    }
  ])('fences an internally contradictory $label', async ({ item }) => {
    render(<SttApp />);
    const channel = await startLive();
    seed(channel);
    emit(channel, created(item));
    expectFence();
    emit(channel, ack('target', 'ack-target', 'seed'));
    emit(channel, final('target', 'final-target', 'Rejected speech'));
    expect(displayedText()).toBe(seedText);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectSafeExports(seedText);
  });

  describe.each([
    { label: 'absent metadata', item: {} },
    { label: 'unknown item and role', item: { type: 'future_item', role: 'future_role' } },
    { label: 'unknown content only', item: { content: [{}, { type: 'future_part' }] } },
    {
      label: 'user input audio with unknown companion',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio' }, { type: 'future_part' }, {}]
      }
    }
  ])('$label', ({ item }) => {
    it.each(['metadata first', 'pending audio first', 'resolved audio first'] as const)(
      'allows neutral metadata: %s',
      async (order) => {
        render(<SttApp />);
        const channel = await startLive();
        seed(channel);
        if (order === 'metadata first') emit(channel, created(item));
        emit(channel, ack('target', 'ack-target', 'seed'));
        if (order === 'pending audio first') emit(channel, created(item));
        emit(channel, final('target', 'final-target', 'Valid speech'));
        if (order === 'resolved audio first') emit(channel, created(item));
        expect(displayedText()).toBe(`${seedText} Valid speech`);
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await expectSafeExports(`${seedText} Valid speech`);
      }
    );
  });

  it('keeps a genuinely unknown predecessor provisional until late metadata resolves it', async () => {
    render(<SttApp />);
    const channel = await startLive();
    seed(channel);
    emit(channel, {
      type: 'conversation.item.created',
      event_id: 'sparse-created',
      item: { id: 'target' }
    });
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'sparse-ack',
      item_id: 'target'
    });
    emit(channel, final('target', 'sparse-final', 'Provisional speech'));
    expect(displayedText()).toBe(`${seedText} Provisional speech`);
    for (const name of ['Copy transcript', 'TXT', 'JSON'] as const) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    emit(channel, created({ content: [{ type: 'future_part' }] }, 'late-predecessor'));
    expect(displayedText()).toBe(`${seedText} Provisional speech`);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectSafeExports(`${seedText} Provisional speech`);
  });

  it('deduplicates exact events and fences a conflicting event ID', async () => {
    render(<SttApp />);
    const channel = await startLive();
    seed(channel);
    const audio = created({ type: 'message', role: 'user', content: [{ type: 'input_audio' }] });
    const acknowledgement = ack('target', 'ack-target', 'seed');
    const completion = final('target', 'final-target', 'Once');
    for (const event of [audio, acknowledgement, completion]) {
      emit(channel, event);
      emit(channel, event);
    }
    expect(displayedText()).toBe(`${seedText} Once`);
    emit(channel, final('target', 'final-target', 'Conflicting duplicate'));
    expectFence();
    emit(channel, final('later', 'final-later', 'Rejected later speech'));
    expect(displayedText()).toBe(`${seedText} Once`);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectSafeExports(`${seedText} Once`);
  });

  it('accepts a maximum-length item ID and fences an overlong successor', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const validId = 'a'.repeat(256);
    emit(channel, ack(validId, 'valid-ack', null));
    emit(channel, final(validId, 'valid-final', 'Within limit'));
    emit(channel, ack('b'.repeat(257), 'invalid-ack', validId));
    expectFence();
    emit(channel, final('later', 'final-later', 'Rejected later speech'));
    expect(displayedText()).toBe('Within limit');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectSafeExports('Within limit');
  });

  it('bounds event IDs without evicting or accepting later speech', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, ack('target', 'ack-target', null));
    const completion = final('target', 'e'.repeat(256), 'Within event limit');
    emit(channel, completion);
    emit(channel, completion);
    emit(channel, { type: 'rate_limits.updated', event_id: 'f'.repeat(257) });
    expectFence();
    emit(channel, final('later', 'final-later', 'Rejected later speech'));
    expect(displayedText()).toBe('Within event limit');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectSafeExports('Within event limit');
  });

  it('does not allow a retired channel to poison a new session', async () => {
    render(<SttApp />);
    const oldChannel = await startLive();
    seed(oldChannel);
    const oldDelivery = oldChannel.savedDelivery();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const newChannel = await startLive();
    act(() => {
      oldDelivery(created({ type: 'function_call', name: 'fixture', arguments: '{}' }));
    });
    emit(newChannel, ack('new', 'new-ack', null));
    emit(newChannel, final('new', 'new-final', 'New session'));
    expect(displayedText()).toBe(`${seedText} New session`);
    expect(stopTracks[0]).toHaveBeenCalledOnce();
    expect(stopTracks[1]).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectSafeExports(`${seedText} New session`);
  });
});
