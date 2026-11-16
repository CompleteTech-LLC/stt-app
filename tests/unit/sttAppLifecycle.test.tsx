import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
};

let pendingResolutions: Array<() => void>;
let peers: FakePeer[];
let recorders: FakeRecorder[];
type TestStream = { stream: MediaStream; stop: ReturnType<typeof vi.fn<() => void>> };
let streams: TestStream[];
let realtimeResponses: Array<() => Promise<Response>>;
let transcriptionResponses: Array<() => Promise<Response>>;
let getUserMedia: ReturnType<typeof makeGetUserMedia>;
let fetchMock: ReturnType<typeof makeFetch>;

function deferred<Value>(teardownValue: Value): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  pendingResolutions.push(() => resolve(teardownValue));
  return { promise, resolve };
}

function makeStream(): TestStream {
  const track = { stop: vi.fn<() => void>() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  } as unknown as MediaStream;
  const result = { stream, stop: track.stop };
  streams.push(result);
  return result;
}

function makeGetUserMedia() {
  return vi.fn(
    (): Promise<MediaStream> => Promise.reject(new Error('Unexpected microphone request'))
  );
}

function requestPath(input: RequestInfo | URL) {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (value.startsWith('/')) return value;
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

function makeFetch() {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestPath(input);
    const isRealtime = url === '/api/realtime/call' || url.startsWith('/api/realtime/call?');
    const queue = isRealtime
      ? realtimeResponses
      : url === '/api/transcribe'
        ? transcriptionResponses
        : [];
    const respond = queue.shift();
    return respond
      ? respond()
      : Promise.reject(new Error(`Unexpected ${init?.method || 'GET'} request: ${url}`));
  });
}

function answerResponse(): Response {
  return { ok: true, text: async () => 'synthetic SDP answer' } as Response;
}

function transcriptResponse(text: string): Response {
  return {
    ok: true,
    json: async () => ({ transcript: { text, language: 'en', segments: [] } })
  } as Response;
}

class FakeChannel extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  emit(message: Record<string, unknown>) {
    const event = new MessageEvent('message', { data: JSON.stringify(message) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }
}

class FakePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: ((event: Event) => void) | null = null;
  channel = new FakeChannel();
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'synthetic offer' }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => {
    this.changeState('connected');
  });

  constructor() {
    super();
    peers.push(this);
  }

  changeState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    const event = new Event('connectionstatechange');
    this.onconnectionstatechange?.(event);
    this.dispatchEvent(event);
  }
}

class FakeRecorder extends EventTarget {
  static isTypeSupported = vi.fn(() => true);
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
  });

  constructor() {
    super();
    recorders.push(this);
  }

  emitStop() {
    this.state = 'inactive';
    const dataEvent = new Event('dataavailable');
    Object.defineProperty(dataEvent, 'data', { value: new Blob(['synthetic audio']) });
    this.ondataavailable?.(dataEvent as BlobEvent);
    this.dispatchEvent(dataEvent);
    const stopEvent = new Event('stop');
    this.onstop?.(stopEvent);
    this.dispatchEvent(stopEvent);
  }
}

async function resolveDeferred<Value>(pending: Deferred<Value>, value: Value) {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
    await Promise.resolve();
  });
}

async function emitRecorderStop(recorder: FakeRecorder) {
  await act(async () => {
    recorder.emitStop();
    await Promise.resolve();
  });
}

function emitTranscript(peer: FakePeer, itemId: string, text: string) {
  act(() => {
    peer.channel.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript: text
    });
  });
}

async function beginLive(button: 'Start' | 'Retry' = 'Start') {
  fireEvent.click(screen.getByRole('button', { name: button }));
  await screen.findByText('Listening');
}

async function beginFallback() {
  realtimeResponses.push(() => Promise.reject(new TypeError('Synthetic connection failure')));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Recording locally');
  expect(recorders).toHaveLength(1);
  return recorders[0];
}

beforeEach(() => {
  pendingResolutions = [];
  peers = [];
  recorders = [];
  streams = [];
  realtimeResponses = [];
  transcriptionResponses = [];
  getUserMedia = makeGetUserMedia();
  fetchMock = makeFetch();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), { mediaDevices: { getUserMedia } })
  );
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    pendingResolutions.forEach((resolve) => resolve());
    await Promise.resolve();
    await Promise.resolve();
  });
  recorders.forEach((recorder) => {
    if (recorder.state !== 'inactive') recorder.stop();
  });
  peers.forEach((peer) => peer.close());
  streams.forEach(({ stop }) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('live capture resource ownership', () => {
  it('releases fallback media on Stop before transcription settles', async () => {
    const oldMedia = makeStream();
    getUserMedia.mockResolvedValueOnce(oldMedia.stream);
    const transcription = deferred(transcriptResponse('old recording'));
    transcriptionResponses.push(() => transcription.promise);
    render(<SttApp />);
    const recorder = await beginFallback();
    const oldPeer = peers[0];

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const stoppedOnClick = oldMedia.stop.mock.calls.length;
    const closedOnClick = oldPeer.close.mock.calls.length;
    await emitRecorderStop(recorder);

    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(1);
    expect(stoppedOnClick).toBeGreaterThan(0);
    expect(closedOnClick).toBeGreaterThan(0);
    await resolveDeferred(transcription, transcriptResponse('old recording'));
  });

  it.each(['clear', 'edit', 'upload'] as const)(
    'keeps a later %s when a stopped fallback request resolves',
    async (action) => {
      const oldMedia = makeStream();
      getUserMedia.mockResolvedValueOnce(oldMedia.stream);
      const transcription = deferred(transcriptResponse('stale fallback'));
      transcriptionResponses.push(() => transcription.promise);
      render(<SttApp />);
      fireEvent.change(screen.getByLabelText('Transcript text'), {
        target: { value: 'Earlier workspace' }
      });
      const recorder = await beginFallback();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await emitRecorderStop(recorder);
      expect(
        fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
      ).toHaveLength(1);

      let expected = '';
      if (action === 'clear') {
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      } else if (action === 'edit') {
        expected = 'User edit';
        fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: expected } });
      } else {
        expected = 'Replacement upload';
        transcriptionResponses.push(() => Promise.resolve(transcriptResponse(expected)));
        fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
        fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
          target: { files: [new File(['synthetic audio'], 'sample.mp3', { type: 'audio/mpeg' })] }
        });
        fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
        await waitFor(() => expect(screen.getByLabelText('Transcript text')).toHaveValue(expected));
      }

      expect(screen.getByLabelText('Transcript text')).toHaveValue(expected);
      await resolveDeferred(transcription, transcriptResponse('stale fallback'));
      expect(screen.getByLabelText('Transcript text')).toHaveValue(expected);
    }
  );

  it.each(['failed', 'disconnected'] as const)(
    'flushes pending text and releases the %s session before Retry',
    async (state) => {
      const oldMedia = makeStream();
      const newMedia = makeStream();
      getUserMedia.mockResolvedValueOnce(oldMedia.stream).mockResolvedValueOnce(newMedia.stream);
      realtimeResponses.push(
        () => Promise.resolve(answerResponse()),
        () => Promise.resolve(answerResponse())
      );
      render(<SttApp />);
      await beginLive();
      const oldPeer = peers[0];

      act(() => {
        oldPeer.channel.emit({ type: 'input_audio_buffer.speech_started', item_id: 'first' });
        oldPeer.channel.emit({
          type: 'input_audio_buffer.committed',
          item_id: 'second',
          previous_item_id: 'first'
        });
        oldPeer.channel.emit({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: 'first',
          delta: 'Unfinished speech'
        });
      });
      emitTranscript(oldPeer, 'second', 'Buffered speech');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        'Unfinished speech Buffered speech'
      );
      act(() => oldPeer.changeState(state));

      await waitFor(() => expect(oldMedia.stop).toHaveBeenCalled());
      expect(oldPeer.close).toHaveBeenCalled();
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        'Unfinished speech Buffered speech'
      );
      await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
      await beginLive('Retry');
      const newPeer = peers[1];
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        'Unfinished speech Buffered speech'
      );
      emitTranscript(oldPeer, 'first', 'Stale old speech');
      emitTranscript(newPeer, 'new-session-item', 'New speech');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        'Unfinished speech Buffered speech New speech'
      );
      expect(newMedia.stop).not.toHaveBeenCalled();
      expect(newPeer.close).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(newMedia.stop).toHaveBeenCalled();
      expect(newPeer.close).toHaveBeenCalled();
    }
  );

  it('prevents an active fallback Retry from affecting a replacement session', async () => {
    const oldMedia = makeStream();
    const newMedia = makeStream();
    getUserMedia.mockResolvedValueOnce(oldMedia.stream).mockResolvedValueOnce(newMedia.stream);
    const transcription = deferred(transcriptResponse('old recording'));
    transcriptionResponses.push(() => transcription.promise);
    render(<SttApp />);
    const recorder = await beginFallback();
    const oldPeer = peers[0];
    realtimeResponses.push(() => Promise.resolve(answerResponse()));
    const retry = screen.getByRole('button', { name: 'Retry' });
    const retryWasEnabled = !retry.hasAttribute('disabled');
    fireEvent.click(retry);
    let stopEventDelivered = false;

    if (!retryWasEnabled) {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await emitRecorderStop(recorder);
      stopEventDelivered = true;
    } else {
      await waitFor(() =>
        expect(
          getUserMedia.mock.calls.length > 1 ||
            recorder.stop.mock.calls.length > 0 ||
            oldMedia.stop.mock.calls.length > 0
        ).toBe(true)
      );
      if (getUserMedia.mock.calls.length === 1) {
        await emitRecorderStop(recorder);
        stopEventDelivered = true;
      }
    }

    if (getUserMedia.mock.calls.length === 1) {
      await resolveDeferred(transcription, transcriptResponse('old recording'));
      if (retryWasEnabled) {
        await screen.findByText('Listening');
      } else {
        await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
        await beginLive('Retry');
      }
      expect(oldMedia.stop).toHaveBeenCalled();
      expect(oldPeer.close).toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('Transcript text'), {
        target: { value: 'New workspace' }
      });
      emitTranscript(peers[1], 'new-session-item', 'New speech');
      expect(screen.getByLabelText('Transcript text')).toHaveValue('New workspace New speech');
    } else {
      await screen.findByText('Listening');
      const newPeer = peers[1];
      const oldStoppedAtRetry = oldMedia.stop.mock.calls.length;
      const oldClosedAtRetry = oldPeer.close.mock.calls.length;
      emitTranscript(newPeer, 'new-session-item', 'New speech');
      if (!stopEventDelivered) await emitRecorderStop(recorder);
      await resolveDeferred(transcription, transcriptResponse('old recording'));

      expect(screen.getByLabelText('Transcript text')).toHaveValue('New speech');
      expect(newMedia.stop).not.toHaveBeenCalled();
      expect(newPeer.close).not.toHaveBeenCalled();
      expect(oldStoppedAtRetry).toBeGreaterThan(0);
      expect(oldClosedAtRetry).toBeGreaterThan(0);
    }

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(newMedia.stop).toHaveBeenCalled();
    expect(peers[1].close).toHaveBeenCalled();
  });
});
