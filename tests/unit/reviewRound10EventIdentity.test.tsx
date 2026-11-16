import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type ServerEvent = Record<string, unknown>;
type ClientCommit = { type: string; event_id?: unknown };
type TestStream = { stream: MediaStream; stop: ReturnType<typeof vi.fn<() => void>> };

let peers: TestPeer[];
let streams: TestStream[];
let downloads: Blob[];
let unexpectedActions: string[];
let allowedMicrophones: number;
let allowedOffers: number;
let copyText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

class TestChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  messageListeners: EventListenerOrEventListenerObject[] = [];
  send = vi.fn<(value: string) => void>();
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

  saveDelivery() {
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
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'synthetic offer' }));
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

class UnexpectedRecorder {
  static isTypeSupported() {
    return false;
  }

  constructor() {
    unexpectedActions.push('Unexpected local recording');
    throw new Error('Unexpected local recording');
  }
}

function emit(channel: TestChannel, event: ServerEvent) {
  act(() => channel.emit(event));
}

function transcript() {
  return (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
}

function finishButton() {
  return screen.getByRole('button', { name: 'Finish turn' });
}

function finishTurn(channel: TestChannel) {
  const previousCount = channel.send.mock.calls.length;
  expect(finishButton()).toBeEnabled();
  fireEvent.click(finishButton());
  expect(channel.send).toHaveBeenCalledTimes(previousCount + 1);
  const commit = JSON.parse(channel.send.mock.calls[previousCount][0]) as ClientCommit;
  expect(commit.type).toBe('input_audio_buffer.commit');
  if (commit.event_id !== undefined) {
    expect(typeof commit.event_id).toBe('string');
    expect((commit.event_id as string).length).toBeGreaterThan(0);
    expect((commit.event_id as string).length).toBeLessThanOrEqual(512);
  }
  expect(finishButton()).toBeDisabled();
  return commit;
}

function expectPending(channel: TestChannel, count: number) {
  expect(finishButton()).toBeDisabled();
  fireEvent.click(finishButton());
  expect(channel.send).toHaveBeenCalledTimes(count);
}

function expectFence() {
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(/paused|conflict|reused|invalid|malformed|limit/i);
  expect(alert).toHaveTextContent(/stop.*start/i);
}

function expectRecoveryGuidance() {
  expect(screen.getByRole('alert')).toHaveTextContent(/stop.*start|retry/i);
}

async function startLive() {
  allowedMicrophones += 1;
  allowedOffers += 1;
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Listening', undefined, { timeout: 1000 });
  expect(allowedMicrophones).toBe(0);
  expect(allowedOffers).toBe(0);
  return peers[peers.length - 1].channel;
}

async function readDownload(name: 'TXT' | 'JSON') {
  const count = downloads.length;
  fireEvent.click(screen.getByRole('button', { name }));
  expect(downloads).toHaveLength(count + 1);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(downloads[downloads.length - 1]);
  });
}

async function expectExports(text: string) {
  expect(transcript()).toBe(text);
  expect(await readDownload('TXT')).toBe(text.endsWith('\n') ? text : `${text}\n`);
  const json = JSON.parse(await readDownload('JSON')) as { text: string; segments: unknown[] };
  expect(json.text).toBe(text);
  expect(json.segments).toEqual([]);
}

async function expectNoUnlabeledExport() {
  const text = transcript();
  const hasOrderLabel = /order unconfirmed/i.test(text);
  for (const name of ['Copy transcript', 'TXT', 'JSON'] as const) {
    const button = screen.getByRole('button', { name });
    if (!hasOrderLabel) {
      expect(button).toBeDisabled();
    } else if (!button.hasAttribute('disabled')) {
      expect(text.toLowerCase().indexOf('order unconfirmed')).toBeLessThan(
        Math.min(text.indexOf('first'), text.indexOf('second'))
      );
      if (name === 'Copy transcript') {
        fireEvent.click(button);
        expect(copyText).toHaveBeenLastCalledWith(text);
      } else {
        const exported = await readDownload(name);
        const exportedText = name === 'JSON' ? (JSON.parse(exported).text as string) : exported;
        expect(exportedText).toContain('order unconfirmed');
        expect(exportedText).toContain('first');
        expect(exportedText).toContain('second');
      }
    }
  }
}

beforeEach(() => {
  peers = [];
  streams = [];
  downloads = [];
  unexpectedActions = [];
  allowedMicrophones = 0;
  allowedOffers = 0;
  copyText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  const getUserMedia = vi.fn(async () => {
    if (allowedMicrophones < 1) {
      unexpectedActions.push('Unexpected microphone request');
      throw new Error('Unexpected microphone request');
    }
    allowedMicrophones -= 1;
    const track = { stop: vi.fn<() => void>() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track]
    } as unknown as MediaStream;
    streams.push({ stream, stop: track.stop });
    return stream;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (path === '/api/realtime/call' && init?.method === 'POST' && allowedOffers > 0) {
        allowedOffers -= 1;
        return Promise.resolve({ ok: true, text: async () => 'synthetic answer' } as Response);
      }
      unexpectedActions.push(`Unexpected ${init?.method || 'GET'} request: ${path}`);
      return Promise.reject(new Error('Unexpected request'));
    })
  );
  vi.stubGlobal('RTCPeerConnection', TestPeer);
  vi.stubGlobal('MediaRecorder', UnexpectedRecorder);
  const navigatorFixture = Object.create(navigator);
  Object.defineProperties(navigatorFixture, {
    mediaDevices: { value: { getUserMedia }, configurable: true },
    clipboard: { value: { writeText: copyText }, configurable: true }
  });
  vi.stubGlobal('navigator', navigatorFixture);
  const NativeURL = URL;
  vi.stubGlobal(
    'URL',
    Object.assign(class extends NativeURL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        downloads.push(blob);
        return 'blob:synthetic-download';
      }),
      revokeObjectURL: vi.fn()
    })
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  try {
    cleanup();
    expect(unexpectedActions).toEqual([]);
    expect(allowedMicrophones).toBe(0);
    expect(allowedOffers).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('server event identity and turn control', () => {
  it('fences the eA/eB cross-kind collision without trusting provisional order', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'eA',
      item_id: 'A',
      transcript: 'first'
    });
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'eB',
      item_id: 'B',
      transcript: 'second'
    });
    expect(transcript()).toBe('first second');
    for (const name of ['Copy transcript', 'TXT', 'JSON']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'eA',
      item_id: 'B',
      previous_item_id: 'A'
    });
    expectFence();
    const fencedText = transcript();
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'eB',
      item_id: 'A',
      previous_item_id: null
    });
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'later-valid-A',
      item_id: 'A',
      previous_item_id: null
    });
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'later-valid-B',
      item_id: 'B',
      previous_item_id: 'A'
    });
    expect(transcript()).toBe(fencedText);
    expect(transcript()).toContain('first');
    expect(transcript()).toContain('second');
    await expectNoUnlabeledExport();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const retained = transcript();
    expect(retained.match(/\[Live item; order unconfirmed\]/g)).toHaveLength(2);
    expect(retained).toContain('first');
    expect(retained).toContain('second');
    await expectExports(retained);
    const replacement = await startLive();
    emit(replacement, {
      type: 'input_audio_buffer.committed',
      event_id: 'recovery-ack',
      item_id: 'recovery',
      previous_item_id: null
    });
    emit(replacement, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'recovery-final',
      item_id: 'recovery',
      transcript: 'new speech'
    });
    expect(transcript()).toContain(retained);
    expect(transcript()).toContain('new speech');
  });

  it('fences a transcription event that reuses an earlier registration ID', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'draft-event',
      item_id: 'A',
      previous_item_id: null,
      delta: 'saved draft'
    });
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'registration-event',
      item_id: 'A',
      previous_item_id: null
    });
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'registration-event',
      item_id: 'A',
      transcript: 'untrusted replacement'
    });
    expectFence();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'later-final',
      item_id: 'A',
      transcript: 'also rejected'
    });
    expect(transcript()).toBe('saved draft');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectExports('saved draft');
  });

  it('does not let a conflicting registration ID settle a pending turn', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'registration-event',
      item_id: 'A',
      previous_item_id: null
    });
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'draft-event',
      item_id: 'A',
      delta: 'saved draft'
    });
    finishTurn(channel);
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'registration-event',
      item_id: 'B',
      previous_item_id: 'A'
    });
    expectPending(channel, 1);
    expectFence();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'later-final',
      item_id: 'A',
      transcript: 'also rejected'
    });
    expect(transcript()).toBe('saved draft');
  });

  it('ignores duplicate registrations and ACKs before completing a distinct turn', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const registration = {
      type: 'input_audio_buffer.speech_started',
      event_id: 'registration-A',
      item_id: 'A',
      previous_item_id: null
    };
    const firstAck = {
      type: 'input_audio_buffer.committed',
      event_id: 'ack-A',
      item_id: 'A',
      previous_item_id: null
    };
    finishTurn(channel);
    emit(channel, registration);
    emit(channel, firstAck);
    expect(finishButton()).toBeEnabled();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'draft-A',
      item_id: 'A',
      delta: 'first draft'
    });
    finishTurn(channel);
    emit(channel, registration);
    emit(channel, firstAck);
    expectPending(channel, 2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'ack-B',
      item_id: 'B',
      previous_item_id: 'A'
    });
    expect(finishButton()).toBeEnabled();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'final-B',
      item_id: 'B',
      transcript: 'second'
    });
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'final-A',
      item_id: 'A',
      transcript: 'first'
    });
    expect(screen.queryByText(/Live item order is unconfirmed/)).not.toBeInTheDocument();
    await expectExports('first second');
  });

  it.each(['missing correlation', 'unrelated correlation', 'old correlation', 'outer ID only'])(
    'does not release a pending turn for %s or expose provider error text',
    async (kind) => {
      const logs = [
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'warn'),
        vi.spyOn(console, 'error')
      ];
      render(<SttApp />);
      const channel = await startLive();
      const firstCommit = finishTurn(channel);
      emit(channel, {
        type: 'input_audio_buffer.committed',
        event_id: 'ack-A',
        item_id: 'A',
        previous_item_id: null
      });
      emit(channel, {
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'final-A',
        item_id: 'A',
        transcript: 'accepted'
      });
      const pendingCommit = finishTurn(channel);
      if (typeof firstCommit.event_id === 'string' && typeof pendingCommit.event_id === 'string') {
        expect(pendingCommit.event_id).not.toBe(firstCommit.event_id);
      }
      const privateText = 'PRIVATE_PROVIDER_ERROR_DETAILS';
      const clientId =
        kind === 'old correlation' && typeof firstCommit.event_id === 'string'
          ? firstCommit.event_id
          : 'unrelated-client-event';
      emit(channel, {
        type: 'error',
        event_id:
          kind === 'outer ID only' && typeof pendingCommit.event_id === 'string'
            ? pendingCommit.event_id
            : 'server-error-event',
        error: {
          ...(kind === 'missing correlation' ? {} : { event_id: clientId }),
          type: 'private_provider_type',
          code: 'private_provider_code',
          message: privateText
        }
      });
      expectPending(channel, 2);
      expect(transcript()).toBe('accepted');
      expect(document.body.textContent).not.toContain(privateText);
      expect(document.body.textContent).not.toContain('private_provider_code');
      expect(document.body.textContent).not.toContain('private_provider_type');
      logs.forEach((log) => {
        const output = JSON.stringify(log.mock.calls);
        expect(output).not.toContain(privateText);
        expect(output).not.toContain('private_provider_code');
        expect(output).not.toContain('private_provider_type');
      });
      emit(channel, {
        type: 'input_audio_buffer.committed',
        event_id: 'ack-B',
        item_id: 'B',
        previous_item_id: 'A'
      });
      if (finishButton().hasAttribute('disabled')) {
        expectRecoveryGuidance();
        expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        const replacement = await startLive();
        finishTurn(replacement);
      } else {
        expect(finishButton()).toBeEnabled();
        emit(channel, {
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: 'final-B',
          item_id: 'B',
          transcript: 'next'
        });
        await expectExports('accepted next');
      }
    }
  );

  it('correlates matching nested client errors or recovers without a client ID', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    render(<SttApp />);
    const channel = await startLive();
    const commit = finishTurn(channel);
    const privateText = 'PRIVATE_MATCHING_ERROR_DETAILS';
    emit(channel, {
      type: 'error',
      event_id: 'distinct-server-error',
      error: {
        event_id: typeof commit.event_id === 'string' ? commit.event_id : 'unrelated-client-event',
        message: privateText
      }
    });
    expect(document.body.textContent).not.toContain(privateText);
    logs.forEach((log) => expect(JSON.stringify(log.mock.calls)).not.toContain(privateText));
    if (typeof commit.event_id === 'string') {
      expect(screen.getByRole('alert')).toHaveTextContent(/turn|audio|commit|error|retry|stop/i);
      if (finishButton().hasAttribute('disabled')) {
        expectRecoveryGuidance();
        expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        const replacement = await startLive();
        finishTurn(replacement);
      } else {
        const retry = finishTurn(channel);
        if (typeof retry.event_id === 'string') expect(retry.event_id).not.toBe(commit.event_id);
      }
    } else {
      expectPending(channel, 1);
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      const replacement = await startLive();
      finishTurn(replacement);
    }
  });

  it.each([
    { label: 'null', id: null },
    { label: 'empty', id: '' },
    { label: 'number', id: 7 },
    { label: 'object', id: { id: 'bad' } },
    { label: 'array', id: ['bad'] },
    { label: 'overlong', id: 'x'.repeat(257) }
  ])('fences a present $label registration ID before releasing the turn', async ({ id }) => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'ack-A',
      item_id: 'A',
      previous_item_id: null
    });
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'draft-A',
      item_id: 'A',
      delta: 'preserved draft'
    });
    finishTurn(channel);
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: id,
      item_id: 'B',
      previous_item_id: 'A'
    });
    expectPending(channel, 1);
    expectFence();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'later-final',
      item_id: 'A',
      transcript: 'must not replace draft'
    });
    expect(transcript()).toBe('preserved draft');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectExports('preserved draft');
  });

  it('never treats a repeated missing-ID ACK as proof a later turn completed', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const missingIdAck = {
      type: 'input_audio_buffer.committed',
      item_id: 'A',
      previous_item_id: null
    };
    finishTurn(channel);
    emit(channel, missingIdAck);
    if (!finishButton().hasAttribute('disabled')) {
      finishTurn(channel);
      emit(channel, missingIdAck);
      expectPending(channel, 2);
    } else {
      expectPending(channel, 1);
    }
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const replacement = await startLive();
    finishTurn(replacement);
  });

  it('retains safe no-ID transcript delta and final semantics', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'identified-registration',
      item_id: 'A',
      previous_item_id: null
    });
    const delta = {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      delta: 'ha'
    };
    emit(channel, delta);
    emit(channel, delta);
    expect(transcript()).toBe('haha');
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'A',
      transcript: 'corrected'
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await expectExports('corrected');
  });

  it('counts registration IDs toward the bounded 4,096-event session limit', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, {
      type: 'input_audio_buffer.committed',
      event_id: 'registration-A',
      item_id: 'A',
      previous_item_id: null
    });
    act(() => {
      for (let index = 0; index < 4095; index += 1) {
        channel.emit({
          type: 'conversation.item.input_audio_transcription.delta',
          event_id: `delta-${index}`,
          item_id: 'A',
          delta: '.'
        });
      }
    });
    expect(transcript()).toBe('.'.repeat(4095));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'overflow-event',
      item_id: 'A',
      transcript: 'must not replace draft'
    });
    expectFence();
    expect(screen.getByRole('alert')).toHaveTextContent(/event.*limit/i);
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'delta-0',
      item_id: 'A',
      transcript: 'must not replace draft'
    });
    expect(transcript()).toBe('.'.repeat(4095));
  }, 15000);

  it('rejects saved old-channel messages during a replacement turn', async () => {
    render(<SttApp />);
    const oldChannel = await startLive();
    const savedDelivery = oldChannel.saveDelivery();
    emit(oldChannel, {
      type: 'input_audio_buffer.committed',
      event_id: 'session-local-event',
      item_id: 'A',
      previous_item_id: null
    });
    emit(oldChannel, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'old-final',
      item_id: 'A',
      transcript: 'accepted'
    });
    emit(oldChannel, {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'old-draft',
      item_id: 'B',
      previous_item_id: 'A',
      delta: 'draft'
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(transcript()).toBe('accepted draft');
    expect(streams[0].stop).toHaveBeenCalled();
    const replacement = await startLive();
    const pending = finishTurn(replacement);
    act(() => {
      savedDelivery({
        type: 'input_audio_buffer.committed',
        event_id: 'stale-ack',
        item_id: 'B',
        previous_item_id: 'A'
      });
      savedDelivery({
        type: 'error',
        event_id: 'stale-error',
        error: {
          event_id: typeof pending.event_id === 'string' ? pending.event_id : 'unrelated',
          message: 'PRIVATE_STALE_ERROR'
        }
      });
      savedDelivery({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'stale-final',
        item_id: 'stale',
        previous_item_id: null,
        transcript: 'stale injection'
      });
    });
    expectPending(replacement, 1);
    expect(transcript()).toBe('accepted draft');
    expect(document.body.textContent).not.toContain('PRIVATE_STALE_ERROR');
    expect(screen.getByText('Listening')).toBeVisible();
    expect(streams[1].stop).not.toHaveBeenCalled();
    emit(replacement, {
      type: 'input_audio_buffer.committed',
      event_id: 'session-local-event',
      item_id: 'new',
      previous_item_id: null
    });
    expect(finishButton()).toBeEnabled();
    emit(replacement, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'new-final',
      item_id: 'new',
      transcript: 'new speech'
    });
    await expectExports('accepted draft new speech');
  });
});
