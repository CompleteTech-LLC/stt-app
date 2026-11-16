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

describe('live capture cleanup', () => {
  it('stops a late microphone stream after unmount without creating a peer', async () => {
    const lateMedia = makeStream();
    const microphone = deferred(lateMedia.stream);
    getUserMedia.mockReturnValueOnce(microphone.promise);
    const view = render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(getUserMedia).toHaveBeenCalledOnce();
    view.unmount();

    await resolveDeferred(microphone, lateMedia.stream);
    expect(lateMedia.stop).toHaveBeenCalled();
    expect(peers).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases an active microphone and peer on unmount', async () => {
    const media = makeStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    realtimeResponses.push(() => Promise.resolve(answerResponse()));
    const view = render(<SttApp />);
    await beginLive();
    const peer = peers[0];

    view.unmount();
    expect(media.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
  });

  it('releases the microphone and peer when an active fallback unmounts', async () => {
    const media = makeStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    const view = render(<SttApp />);
    await beginFallback();
    const peer = peers[0];

    view.unmount();
    expect(media.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
  });

  it('aborts a pending SDP request on Stop and ignores a late answer', async () => {
    const media = makeStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    const answer = deferred(answerResponse());
    realtimeResponses.push(() => answer.promise);
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const peer = peers[0];
    const [request, options] = fetchMock.mock.calls[0];
    const signal =
      options?.signal ??
      (typeof request !== 'string' && !(request instanceof URL) ? request.signal : undefined);
    const abortedBeforeStop = signal?.aborted;

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await resolveDeferred(answer, answerResponse());

    expect(abortedBeforeStop).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(media.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });
});
