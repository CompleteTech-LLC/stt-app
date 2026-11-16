import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  pendingResolutions.push(() => resolve(teardownValue));
  return { promise, resolve, reject };
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
  readyState: RTCDataChannelState = 'open';
  send = vi.fn((value: string) => value);
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
  onerror: ((event: Event) => void) | null = null;
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
      ...(itemId === 'new-session-item' ? { previous_item_id: null } : {}),
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
  it('submits only explicit turns on the active channel and retires it on Stop', async () => {
    getUserMedia
      .mockResolvedValueOnce(makeStream().stream)
      .mockResolvedValueOnce(makeStream().stream);
    realtimeResponses.push(
      () => Promise.resolve(answerResponse()),
      () => Promise.resolve(answerResponse())
    );
    render(<SttApp />);
    await beginLive();
    const oldChannel = peers[0].channel;
    const oldHandler = oldChannel.onmessage;
    const finish = screen.getByRole('button', { name: 'Finish turn' });
    expect(oldChannel.send).not.toHaveBeenCalled();
    fireEvent.click(finish);
    expect(oldChannel.send).toHaveBeenCalledOnce();
    expect(JSON.parse(oldChannel.send.mock.calls[0][0] as string)).toEqual({
      type: 'input_audio_buffer.commit'
    });
    expect(finish).toBeDisabled();
    act(() =>
      oldChannel.emit({
        type: 'input_audio_buffer.committed',
        item_id: 'A',
        previous_item_id: null
      })
    );
    expect(finish).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(finish).toBeDisabled();
    await beginLive();
    const currentChannel = peers[1].channel;
    act(() =>
      oldHandler?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'stale' })
        })
      )
    );
    expect(currentChannel.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(currentChannel.send).toHaveBeenCalledOnce();
  });

  it.each(['clear', 'edit', 'new live', 'new upload', 'unmount'] as const)(
    'does not let an old upload override %s',
    async (action) => {
      const pending = deferred(transcriptResponse('stale upload'));
      transcriptionResponses.push(() => pending.promise);
      const view = render(<SttApp />);
      fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
      const input = screen.getByLabelText(/Audio and video files accepted/);
      fireEvent.change(input, {
        target: { files: [new File(['audio'], 'old.mp3', { type: 'audio/mpeg' })] }
      });
      fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
      const oldSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
      let expected = '';
      if (action === 'clear') fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      if (action === 'edit') {
        expected = 'New edit';
        fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: expected } });
      }
      if (action === 'new live') {
        getUserMedia.mockResolvedValueOnce(makeStream().stream);
        realtimeResponses.push(() => Promise.resolve(answerResponse()));
        fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
        await beginLive();
        emitTranscript(peers[0], 'new-session-item', 'New speech');
        expected = 'New speech';
      }
      if (action === 'new upload') {
        expected = 'New upload';
        transcriptionResponses.push(() => Promise.resolve(transcriptResponse(expected)));
        fireEvent.change(input, {
          target: { files: [new File(['audio'], 'new.mp3', { type: 'audio/mpeg' })] }
        });
        fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
        await waitFor(() => expect(screen.getByLabelText('Transcript text')).toHaveValue(expected));
      }
      if (action === 'unmount') view.unmount();
      expect(oldSignal.aborted).toBe(true);
      await resolveDeferred(pending, transcriptResponse('stale upload'));
      if (action !== 'unmount')
        expect(screen.getByLabelText('Transcript text')).toHaveValue(expected);
      if (action === 'new live') {
        act(() =>
          peers[0].channel.emit({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'next',
            previous_item_id: 'new-session-item',
            transcript: 'more'
          })
        );
        expect(screen.getByLabelText('Transcript text')).toHaveValue('New speech more');
      }
    }
  );

  it.each([
    ['recording', 'clear'],
    ['recording', 'edit'],
    ['recording', 'upload'],
    ['stop pending', 'clear'],
    ['stop pending', 'edit'],
    ['stop pending', 'upload']
  ] as const)('discards fallback audio before upload on %s workspace %s', async (phase, action) => {
    const media = makeStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    render(<SttApp />);
    const recorder = await beginFallback();
    const oldStop = recorder.onstop;
    if (phase === 'stop pending') fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    if (action === 'clear') fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    if (action === 'edit')
      fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'Edited' } });
    if (action === 'upload') {
      transcriptionResponses.push(() => Promise.resolve(transcriptResponse('Uploaded')));
      fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
      fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
        target: { files: [new File(['audio'], 'new.mp3', { type: 'audio/mpeg' })] }
      });
      fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
      await waitFor(() => expect(screen.getByLabelText('Transcript text')).toHaveValue('Uploaded'));
    }
    expect(media.stop).toHaveBeenCalled();
    expect(recorder.stop).toHaveBeenCalled();
    expect(
      screen.getByText(/local recording was discarded.*will not be transcribed/i)
    ).toBeVisible();
    expect(screen.queryByText(/audio already sent cannot be retracted/i)).not.toBeInTheDocument();
    act(() => oldStop?.(new Event('stop')));
    await emitRecorderStop(recorder);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(action === 'upload' ? 1 : 0);
  });

  it.each([
    ['microphone', 'clear', 'before new session'],
    ['microphone', 'edit', 'before new session'],
    ['microphone', 'upload', 'before new session'],
    ['SDP', 'clear', 'before new session'],
    ['SDP', 'edit', 'before new session'],
    ['SDP', 'upload', 'before new session'],
    ['SDP', 'edit', 'after new session']
  ] as const)(
    'retires pending %s setup on workspace %s (%s) without starting fallback',
    async (phase, action, failureTiming) => {
      const oldMedia = makeStream();
      const newMedia = makeStream();
      const microphone = deferred(oldMedia.stream);
      const setup = deferred(answerResponse());
      if (phase === 'microphone') {
        getUserMedia.mockReturnValueOnce(microphone.promise);
      } else {
        getUserMedia.mockResolvedValueOnce(oldMedia.stream);
        realtimeResponses.push(() => setup.promise);
      }
      getUserMedia.mockResolvedValueOnce(newMedia.stream);
      render(<SttApp />);
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      if (phase === 'microphone') {
        await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      } else {
        await waitFor(() =>
          expect(
            fetchMock.mock.calls.filter(([input]) =>
              requestPath(input).startsWith('/api/realtime/call')
            )
          ).toHaveLength(1)
        );
      }
      const oldPeer = peers[0];
      const oldMessage = oldPeer?.channel.onmessage;
      const oldConnectionChange = oldPeer?.onconnectionstatechange;
      const setupCall = fetchMock.mock.calls.find(([input]) =>
        requestPath(input).startsWith('/api/realtime/call')
      );
      const setupSignal = setupCall?.[1]?.signal as AbortSignal | undefined;
      let expected = '';
      if (action === 'clear') {
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      } else if (action === 'edit') {
        expected = 'Edited\n  note';
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
        fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      }
      expect(screen.getByText(/Live setup stopped because the workspace changed/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      if (phase === 'SDP') {
        expect(setupSignal?.aborted).toBe(true);
        expect(oldMedia.stop).toHaveBeenCalled();
        expect(oldPeer.close).toHaveBeenCalled();
      }
      const rejectSetup = async () => {
        await act(async () => {
          setup.reject(new TypeError('Synthetic SDP failure'));
          await expect(setup.promise).rejects.toThrow('Synthetic SDP failure');
        });
      };
      if (phase === 'SDP' && failureTiming === 'before new session') {
        await rejectSetup();
        expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(recorders).toHaveLength(0);
      }

      realtimeResponses.push(() => Promise.resolve(answerResponse()));
      await beginLive();
      if (phase === 'microphone') {
        await resolveDeferred(microphone, oldMedia.stream);
      } else {
        if (failureTiming === 'after new session') await rejectSetup();
        act(() => {
          oldPeer.connectionState = 'failed';
          oldConnectionChange?.(new Event('connectionstatechange'));
          oldMessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: 'stale',
                previous_item_id: null,
                transcript: 'stale speech'
              })
            })
          );
        });
      }
      expect(oldMedia.stop).toHaveBeenCalled();
      expect(newMedia.stop).not.toHaveBeenCalled();
      expect(peers.at(-1)?.close).not.toHaveBeenCalled();
      expect(recorders).toHaveLength(0);
      expect(screen.getByLabelText('Transcript text')).toHaveValue(expected);
      emitTranscript(peers.at(-1)!, 'new-session-item', 'New speech');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        expected ? `${expected} New speech` : 'New speech'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(
        fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
      ).toHaveLength(action === 'upload' ? 1 : 0);
    }
  );

  it('keeps pending setup and normal fallback when a replacement upload fails', async () => {
    const media = makeStream();
    const setup = deferred(answerResponse());
    getUserMedia.mockResolvedValueOnce(media.stream);
    realtimeResponses.push(() => setup.promise);
    transcriptionResponses.push(
      () =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'Synthetic upload failure' } })
        } as Response),
      () => Promise.resolve(transcriptResponse('Normal fallback'))
    );
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          requestPath(input).startsWith('/api/realtime/call')
        )
      ).toHaveLength(1)
    );
    const setupSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
    fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
      target: { files: [new File(['synthetic audio'], 'sample.mp3', { type: 'audio/mpeg' })] }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
    await screen.findByText('Synthetic upload failure');
    expect(setupSignal.aborted).toBe(false);
    expect(media.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
    await act(async () => {
      setup.reject(new TypeError('Synthetic SDP failure'));
      await expect(setup.promise).rejects.toThrow('Synthetic SDP failure');
    });
    await screen.findByText('Recording locally');
    expect(recorders).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await emitRecorderStop(recorders[0]);
    await waitFor(() =>
      expect(screen.getByLabelText('Transcript text')).toHaveValue('Normal fallback')
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(2);
  });

  it('retires old peer events and promptly releases an unsolicited recorder stop', async () => {
    const media = makeStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    const pending = deferred(transcriptResponse('recording'));
    transcriptionResponses.push(() => pending.promise);
    render(<SttApp />);
    const recorder = await beginFallback();
    const peer = peers[0];
    expect(peer.close).toHaveBeenCalled();
    act(() => {
      peer.changeState('connected');
      peer.changeState('failed');
      peer.changeState('disconnected');
    });
    expect(screen.getByText('Recording locally')).toBeInTheDocument();
    expect(media.stop).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(0);
    await emitRecorderStop(recorder);
    expect(media.stop).toHaveBeenCalled();
    expect(screen.getByText('Recording interrupted')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe recording' }));
    expect(screen.getByText('Transcribing recording')).toBeInTheDocument();
    await resolveDeferred(pending, transcriptResponse('recording'));
  });

  it('releases capture on a recorder error without uploading', async () => {
    const media = makeStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    render(<SttApp />);
    const recorder = await beginFallback();
    act(() => recorder.onerror?.(new Event('error')));
    expect(media.stop).toHaveBeenCalled();
    expect(screen.getByText(/Audio received so far may be incomplete/)).toBeInTheDocument();
    await emitRecorderStop(recorder);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Transcribe recording' })).toBeEnabled();
  });

  it('keeps media released when unsolicited-stop transcription fails', async () => {
    const media = makeStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    transcriptionResponses.push(() => Promise.reject(new Error('transcription failed')));
    render(<SttApp />);
    const recorder = await beginFallback();
    await emitRecorderStop(recorder);
    expect(media.stop).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe recording' }));
    await screen.findByText('transcription failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('ignores saved old peer and recorder callbacks after ownership changes', async () => {
    const setupResponse = { ok: false, status: 503, json: async () => ({}) } as Response;
    const setup = deferred(setupResponse);
    const oldMedia = makeStream();
    const newMedia = makeStream();
    getUserMedia.mockResolvedValueOnce(oldMedia.stream).mockResolvedValueOnce(newMedia.stream);
    realtimeResponses.push(
      () => setup.promise,
      () => Promise.resolve(answerResponse())
    );
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(peers).toHaveLength(1));
    const oldPeer = peers[0];
    const oldPeerCallback = oldPeer.onconnectionstatechange;
    await resolveDeferred(setup, setupResponse);
    await screen.findByText('Recording locally');
    const oldStop = recorders[0].onstop;
    act(() => {
      oldPeer.connectionState = 'failed';
      oldPeerCallback?.(new Event('connectionstatechange'));
    });
    expect(screen.getByText('Recording locally')).toBeInTheDocument();
    expect(oldMedia.stop).not.toHaveBeenCalled();
    await beginLive('Retry');
    act(() => oldStop?.(new Event('stop')));
    expect(newMedia.stop).not.toHaveBeenCalled();
    expect(peers[1].close).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(0);
  });

  it.each(['constructor', 'start', 'unsupported'] as const)(
    'cleans up a fallback %s failure and allows Retry',
    async (failure) => {
      class BadRecorder extends FakeRecorder {
        static isTypeSupported = vi.fn(() => failure !== 'unsupported');
        constructor() {
          super();
          if (failure === 'constructor') throw new Error('constructor failed');
        }
        start = vi.fn((): void => {
          throw new Error('start failed');
        });
      }
      vi.stubGlobal('MediaRecorder', BadRecorder);
      const media = makeStream();
      getUserMedia.mockResolvedValueOnce(media.stream).mockResolvedValueOnce(makeStream().stream);
      realtimeResponses.push(
        () => Promise.reject(new TypeError('offline')),
        () => Promise.resolve(answerResponse())
      );
      render(<SttApp />);
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await screen.findByText('Realtime unavailable');
      expect(media.stop).toHaveBeenCalled();
      expect(peers[0].close).toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
      ).toHaveLength(0);
      await beginLive('Retry');
    }
  );

  it('retains earlier edits and the pending live draft before fallback text', async () => {
    const response = { ok: false, status: 503, json: async () => ({}) } as Response;
    const setup = deferred(response);
    realtimeResponses.push(() => setup.promise);
    transcriptionResponses.push(() => Promise.resolve(transcriptResponse('Fallback speech')));
    getUserMedia.mockResolvedValueOnce(makeStream().stream);
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: '  Earlier\nnotes' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(peers).toHaveLength(1));
    act(() =>
      peers[0].channel.emit({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'first',
        previous_item_id: null,
        delta: 'Pending'
      })
    );
    await resolveDeferred(setup, response);
    await screen.findByText('Recording locally');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await emitRecorderStop(recorders[0]);
    await waitFor(() =>
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        '  Earlier\nnotes Pending Fallback speech'
      )
    );
  });

  it('keeps the prior workspace and live draft when an interrupted recording is discarded', async () => {
    const response = { ok: false, status: 503, json: async () => ({}) } as Response;
    const setup = deferred(response);
    realtimeResponses.push(() => setup.promise);
    getUserMedia.mockResolvedValueOnce(makeStream().stream);
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'Earlier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(peers).toHaveLength(1));
    act(() =>
      peers[0].channel.emit({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'first',
        previous_item_id: null,
        delta: 'Pending'
      })
    );
    await resolveDeferred(setup, response);
    await screen.findByText('Recording locally');
    await emitRecorderStop(recorders[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    expect(screen.getByLabelText('Transcript text')).toHaveValue('Earlier Pending');
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe')
    ).toHaveLength(0);
  });
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
      const fallbackCalls = fetchMock.mock.calls.filter(
        ([input]) => requestPath(input) === '/api/transcribe'
      );
      expect(fallbackCalls).toHaveLength(1);
      const fallbackSignal = fallbackCalls[0][1]?.signal as AbortSignal;
      expect(fallbackSignal.aborted).toBe(false);

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
      expect(fallbackSignal.aborted).toBe(true);
      expect(
        screen.getByText(/Cancellation was requested.*result will be discarded/i)
      ).toHaveTextContent(
        /audio already sent cannot be retracted.*may already have been transcribed/i
      );
      expect(screen.queryByText(/will not be transcribed/i)).not.toBeInTheDocument();
      await resolveDeferred(transcription, transcriptResponse('stale fallback'));
      expect(screen.getByLabelText('Transcript text')).toHaveValue(expected);
      expect(screen.getByText(/Cancellation was requested/)).toBeVisible();
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
        oldPeer.channel.emit({
          type: 'input_audio_buffer.speech_started',
          item_id: 'first',
          previous_item_id: null
        });
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
