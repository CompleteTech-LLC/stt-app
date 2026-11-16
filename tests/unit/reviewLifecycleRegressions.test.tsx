import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
};

type StreamFixture = { stream: MediaStream; stop: ReturnType<typeof vi.fn> };
type RecorderFault = 'none' | 'constructor' | 'start' | 'mime';

let pendingCleanup: Array<() => void>;
let peers: TestPeer[];
let recorders: TestRecorder[];
let realtimeResponses: Array<() => Promise<Response>>;
let fileResponses: Array<() => Promise<Response>>;
let recorderFault: RecorderFault;
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function deferred<Value>(cleanupValue: Value): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  pendingCleanup.push(() => resolve(cleanupValue));
  return { promise, resolve, reject };
}

function streamFixture(): StreamFixture {
  const track = { stop: vi.fn() };
  return {
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
    stop: track.stop
  };
}

function response(text: string): Response {
  return {
    ok: true,
    json: async () => ({
      transcript: { text, language: 'en', model: 'gpt-4o-mini-transcribe', segments: [] }
    })
  } as Response;
}

function answer(): Response {
  return { ok: true, text: async () => 'synthetic answer' } as Response;
}

function requestPath(input: RequestInfo | URL) {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return value.startsWith('/') ? value.split('?')[0] : new URL(value).pathname;
}

function fileCalls() {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe');
}

function sentCommits(channel: TestChannel) {
  return channel.send.mock.calls
    .map(([payload]) => {
      if (typeof payload !== 'string') return null;
      try {
        return JSON.parse(payload) as { type?: string };
      } catch {
        return null;
      }
    })
    .filter((message) => message?.type === 'input_audio_buffer.commit');
}

function recorderError() {
  const event = new Event('error');
  Object.defineProperty(event, 'error', { value: new DOMException('synthetic recorder error') });
  return event;
}

class TestChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 'closed';
  });

  emit(data: Record<string, unknown>) {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
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
    this.channel.readyState = 'open';
    const openEvent = new Event('open');
    this.channel.onopen?.(openEvent);
    this.channel.dispatchEvent(openEvent);
    this.connectionState = 'connected';
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  });
  close = vi.fn(() => {
    this.connectionState = 'closed';
    this.channel.readyState = 'closed';
  });

  constructor() {
    super();
    peers.push(this);
  }
}

class TestRecorder extends EventTarget {
  static isTypeSupported = vi.fn(() => recorderFault !== 'mime');
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  start = vi.fn(() => {
    if (recorderFault === 'start') throw new Error('synthetic recorder start failure');
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
  });

  constructor() {
    super();
    if (recorderFault === 'constructor' || recorderFault === 'mime') {
      throw new Error('synthetic recorder format failure');
    }
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

  emitError() {
    const event = recorderError();
    this.onerror?.(event);
    this.dispatchEvent(event);
  }
}

async function settle<Value>(pending: Deferred<Value>, value: Value) {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
    await Promise.resolve();
  });
}

async function stopEvent(recorder: TestRecorder) {
  await act(async () => {
    recorder.emitStop();
    await Promise.resolve();
  });
}

function emit(peer: TestPeer, event: Record<string, unknown>) {
  act(() => peer.channel.emit(event));
}

function final(peer: TestPeer, itemId: string, text: string, previous: string | null) {
  emit(peer, {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    previous_item_id: previous,
    transcript: text
  });
}

function chooseFile(name = 'synthetic.mp3') {
  fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
    target: { files: [new File(['synthetic audio'], name, { type: 'audio/mpeg' })] }
  });
}

function beginUpload(name?: string) {
  fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
  chooseFile(name);
  fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
}

async function beginLive(button: 'Start' | 'Retry' = 'Start') {
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: button }));
  await screen.findByText('Listening');
  return peers.at(-1)!;
}

async function beginFallback() {
  realtimeResponses.push(() => Promise.reject(new TypeError('synthetic connection failure')));
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Recording locally');
  return recorders.at(-1)!;
}

beforeEach(() => {
  pendingCleanup = [];
  peers = [];
  recorders = [];
  realtimeResponses = [];
  fileResponses = [];
  recorderFault = 'none';
  getUserMedia = vi.fn(() => Promise.resolve(streamFixture().stream));
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    const queue = path === '/api/realtime/call' ? realtimeResponses : fileResponses;
    const next = queue.shift();
    return next
      ? next()
      : Promise.reject(new Error(`Unexpected synthetic ${init?.method || 'GET'} request: ${path}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', TestPeer);
  vi.stubGlobal('MediaRecorder', TestRecorder);
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), { mediaDevices: { getUserMedia } })
  );
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    pendingCleanup.forEach((resolve) => resolve());
    await Promise.resolve();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('upload ownership', () => {
  it.each(['edit', 'clear'] as const)('ignores a pending upload after %s', async (change) => {
    const pending = deferred(response('obsolete upload'));
    fileResponses.push(() => pending.promise);
    render(<SttApp />);
    beginUpload();
    expect(fileCalls()).toHaveLength(1);

    if (change === 'edit') {
      fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'new edit' } });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    }
    await settle(pending, response('obsolete upload'));
    expect(screen.getByLabelText('Transcript text')).toHaveValue(
      change === 'edit' ? 'new edit' : ''
    );
  });

  it('does not overwrite or fence a live session started after the upload', async () => {
    const pending = deferred(response('obsolete upload'));
    fileResponses.push(() => pending.promise);
    realtimeResponses.push(() => Promise.resolve(answer()));
    render(<SttApp />);
    beginUpload();
    const peer = await beginLive();
    final(peer, 'first', 'fresh one', null);
    await settle(pending, response('obsolete upload'));
    final(peer, 'second', 'fresh two', 'first');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('fresh one fresh two');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('allows a newer selected file to supersede an outstanding upload', async () => {
    const first = deferred(response('first upload'));
    const second = deferred(response('second upload'));
    fileResponses.push(
      () => first.promise,
      () => second.promise
    );
    render(<SttApp />);
    beginUpload('first.mp3');
    chooseFile('second.mp3');
    expect(screen.getByRole('button', { name: 'Transcribe file' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
    expect(fileCalls()).toHaveLength(2);
    await settle(second, response('second upload'));
    await settle(first, response('first upload'));
    expect(screen.getByLabelText('Transcript text')).toHaveValue('second upload');
  });

  it('does not affect a remounted workspace when an old upload resolves', async () => {
    const pending = deferred(response('old mount'));
    fileResponses.push(() => pending.promise);
    const oldMount = render(<SttApp />);
    beginUpload();
    const signal = fileCalls()[0]?.[1]?.signal as AbortSignal | undefined;
    oldMount.unmount();
    if (signal) expect(signal.aborted).toBe(true);
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'new mount' } });
    await settle(pending, response('old mount'));
    expect(screen.getByLabelText('Transcript text')).toHaveValue('new mount');
  });

  it('lets a still-owned upload intentionally replace an existing live draft', async () => {
    const pending = deferred(response('replacement upload'));
    realtimeResponses.push(() => Promise.resolve(answer()));
    fileResponses.push(() => pending.promise);
    render(<SttApp />);
    const peer = await beginLive();
    emit(peer, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'draft',
      previous_item_id: null,
      delta: 'existing draft'
    });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('existing draft');
    beginUpload();
    await settle(pending, response('replacement upload'));
    expect(screen.getByLabelText('Transcript text')).toHaveValue('replacement upload');
  });
});

describe('fallback media ownership', () => {
  it.each(['hanging', 'failed'] as const)(
    'releases capture immediately on an unsolicited stop when transcription is %s',
    async (outcome) => {
      const media = streamFixture();
      getUserMedia.mockResolvedValueOnce(media.stream);
      const pending = deferred(response('unused'));
      fileResponses.push(() => pending.promise);
      render(<SttApp />);
      const recorder = await beginFallback();
      const peer = peers[0];
      act(() => {
        recorder.emitStop();
        expect(media.stop).toHaveBeenCalledTimes(1);
        expect(peer.close).toHaveBeenCalledTimes(1);
        expect(fileCalls()).toHaveLength(0);
      });
      expect(screen.getByText('Recording interrupted')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Transcribe recording' })).toBeEnabled();
      expect(fileCalls()).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Transcribe recording' }));
      expect(fileCalls()).toHaveLength(1);
      expect(screen.getByText('Transcribing recording')).toBeInTheDocument();
      expect(media.stop).toHaveBeenCalledTimes(1);
      expect(peer.close).toHaveBeenCalledTimes(1);
      if (outcome === 'failed') {
        await act(async () => {
          pending.reject(new Error('synthetic transcription failure'));
          await pending.promise.catch(() => undefined);
        });
        expect(await screen.findByText(/synthetic transcription failure/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
        expect(media.stop).toHaveBeenCalledTimes(1);
        expect(peer.close).toHaveBeenCalledTimes(1);
        expect(fileCalls()).toHaveLength(1);
      }
    }
  );

  it('releases capture on recorder error even before a stop event arrives', async () => {
    const media = streamFixture();
    getUserMedia.mockResolvedValueOnce(media.stream);
    render(<SttApp />);
    const recorder = await beginFallback();
    act(() => recorder.emitError());
    await waitFor(() => expect(media.stop).toHaveBeenCalled());
    expect(peers[0].close).toHaveBeenCalled();
  });

  it('does not let an old recorder callback or response close a newer session', async () => {
    const oldMedia = streamFixture();
    const newMedia = streamFixture();
    getUserMedia.mockResolvedValueOnce(oldMedia.stream).mockResolvedValueOnce(newMedia.stream);
    const pending = deferred(response('old recording'));
    fileResponses.push(() => pending.promise);
    realtimeResponses.push(() => Promise.reject(new TypeError('synthetic connection failure')));
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Recording locally');
    const recorder = recorders[0];
    const oldStop = recorder.onstop;
    const oldError = recorder.onerror;
    await stopEvent(recorder);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    realtimeResponses.push(() => Promise.resolve(answer()));
    const newPeer = await beginLive('Retry');
    const closeCount = newPeer.close.mock.calls.length;
    const stopCount = newMedia.stop.mock.calls.length;
    await act(async () => {
      oldStop?.(new Event('stop'));
      oldError?.(recorderError());
      recorder.emitError();
      await Promise.resolve();
    });
    await settle(pending, response('old recording'));
    final(newPeer, 'new', 'new speech', null);
    expect(newMedia.stop).toHaveBeenCalledTimes(stopCount);
    expect(newPeer.close).toHaveBeenCalledTimes(closeCount);
    expect(screen.getByLabelText('Transcript text')).toHaveValue('new speech');
  });

  it.each(['connected', 'failed', 'disconnected'] as const)(
    'retires a queued old-peer %s callback after fallback handoff',
    async (state) => {
      const media = streamFixture();
      getUserMedia.mockResolvedValueOnce(media.stream);
      const pendingAnswer = deferred(answer());
      realtimeResponses.push(() => pendingAnswer.promise);
      render(<SttApp />);
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => expect(peers).toHaveLength(1));
      const peer = peers[0];
      const oldCallback = peer.onconnectionstatechange;
      expect(oldCallback).not.toBeNull();
      await act(async () => {
        pendingAnswer.reject(new TypeError('synthetic connection failure'));
        await pendingAnswer.promise.catch(() => undefined);
      });
      await screen.findByText('Recording locally');
      const recorder = recorders[0];
      act(() => {
        peer.connectionState = state;
        oldCallback?.(new Event('connectionstatechange'));
      });
      expect(screen.getByText('Recording locally')).toBeInTheDocument();
      expect(recorder.state).toBe('recording');
      expect(media.stop).not.toHaveBeenCalled();
      expect(fileCalls()).toHaveLength(0);
      fileResponses.push(() => Promise.resolve(response('valid recording')));
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await stopEvent(recorder);
      await screen.findByText('Stopped');
      expect(fileCalls()).toHaveLength(1);
      expect(screen.getByLabelText('Transcript text')).toHaveValue('valid recording');
    }
  );

  it.each(['constructor', 'start', 'mime'] as const)(
    'cleans up a recorder %s failure and supports Retry',
    async (fault) => {
      const failedMedia = streamFixture();
      const retryMedia = streamFixture();
      getUserMedia
        .mockResolvedValueOnce(failedMedia.stream)
        .mockResolvedValueOnce(retryMedia.stream);
      recorderFault = fault;
      realtimeResponses.push(() => Promise.reject(new TypeError('synthetic connection failure')));
      render(<SttApp />);
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => expect(failedMedia.stop).toHaveBeenCalled());
      expect(peers[0].close).toHaveBeenCalled();
      expect(screen.getByText('Realtime unavailable')).toBeInTheDocument();
      expect(
        screen.getByText(
          /(?:record|capture|mime|format).*(?:fail|unavailable|support)|(?:fail|unavailable|support).*(?:record|capture|mime|format)/i
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
      expect(fileCalls()).toHaveLength(0);
      if (fault === 'start') {
        expect(recorders[0].ondataavailable).toBeNull();
        expect(recorders[0].onstop).toBeNull();
        expect(recorders[0].onerror).toBeNull();
        await stopEvent(recorders[0]);
        expect(fileCalls()).toHaveLength(0);
      }
      recorderFault = 'none';
      realtimeResponses.push(() => Promise.resolve(answer()));
      await beginLive('Retry');
      expect(retryMedia.stop).not.toHaveBeenCalled();
    }
  );

  it.each(['edit', 'clear', 'upload'] as const)(
    'keeps the workspace authoritative when %s occurs during fallback recording',
    async (change) => {
      const media = streamFixture();
      getUserMedia.mockResolvedValueOnce(media.stream);
      render(<SttApp />);
      const recorder = await beginFallback();
      let retained = '';
      if (change === 'edit') {
        retained = 'new edit';
        fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: retained } });
      } else if (change === 'clear') {
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      } else {
        retained = 'new upload';
        fileResponses.push(() => Promise.resolve(response(retained)));
        beginUpload();
        await waitFor(() => expect(screen.getByLabelText('Transcript text')).toHaveValue(retained));
        fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      }

      const priorCalls = fileCalls().length;
      if (recorder.state === 'recording') {
        expect(screen.getAllByText(/transcrib\w* (?:after|on) Stop/i).length).toBeGreaterThan(0);
        fileResponses.push(() => Promise.resolve(response('recorded speech')));
        expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await stopEvent(recorder);
        await waitFor(() => expect(fileCalls()).toHaveLength(priorCalls + 1));
        await waitFor(() =>
          expect(screen.getByLabelText('Transcript text')).toHaveValue(
            retained ? `${retained} recorded speech` : 'recorded speech'
          )
        );
      } else {
        expect(media.stop).toHaveBeenCalled();
        await stopEvent(recorder);
        expect(fileCalls()).toHaveLength(priorCalls);
        expect(screen.getByLabelText('Transcript text')).toHaveValue(retained);
      }
    }
  );
});

describe('explicit realtime turn control', () => {
  it('sends an explicit commit only to the current channel and remains safe across Stop', async () => {
    const oldMedia = streamFixture();
    const newMedia = streamFixture();
    getUserMedia.mockResolvedValueOnce(oldMedia.stream).mockResolvedValueOnce(newMedia.stream);
    realtimeResponses.push(
      () => Promise.resolve(answer()),
      () => Promise.resolve(answer())
    );
    render(<SttApp />);
    const oldPeer = await beginLive();
    expect(sentCommits(oldPeer.channel)).toHaveLength(0);
    const controlName = /(?:finish|end|commit|finali[sz]e) (?:audio |speech |current )?turn/i;
    const finishTurn = screen.getByRole('button', { name: controlName });
    expect(finishTurn).toBeEnabled();
    fireEvent.click(finishTurn);
    expect(sentCommits(oldPeer.channel)).toHaveLength(1);
    expect(sentCommits(oldPeer.channel)[0]).toMatchObject({
      type: 'input_audio_buffer.commit'
    });
    expect(fileCalls()).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/realtime/call')
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(oldMedia.stop).toHaveBeenCalled();
    expect(oldPeer.close).toHaveBeenCalled();
    const oldCommitsAfterStop = sentCommits(oldPeer.channel).length;
    const stoppedControl = screen.queryByRole('button', { name: controlName });
    if (stoppedControl) expect(stoppedControl).toBeDisabled();

    const newPeer = await beginLive('Retry');
    expect(sentCommits(newPeer.channel)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: controlName }));
    expect(sentCommits(newPeer.channel)).toHaveLength(1);
    expect(sentCommits(newPeer.channel)[0]).toMatchObject({
      type: 'input_audio_buffer.commit'
    });
    expect(sentCommits(oldPeer.channel)).toHaveLength(oldCommitsAfterStop);
    expect(fileCalls()).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/realtime/call')
    ).toHaveLength(2);
  });

  it('does not send a turn commit through a closed data channel', async () => {
    realtimeResponses.push(() => Promise.resolve(answer()));
    render(<SttApp />);
    const peer = await beginLive();
    const controlName = /(?:finish|end|commit|finali[sz]e) (?:audio |speech |current )?turn/i;
    expect(screen.getByRole('button', { name: controlName })).toBeEnabled();
    const priorCommits = sentCommits(peer.channel).length;
    act(() => {
      peer.channel.readyState = 'closed';
      peer.channel.dispatchEvent(new Event('close'));
    });
    const control = screen.queryByRole('button', { name: controlName });
    if (control) fireEvent.click(control);
    expect(sentCommits(peer.channel)).toHaveLength(priorCommits);
    expect(fileCalls()).toHaveLength(0);
  });
});
