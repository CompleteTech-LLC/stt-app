import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
};
type WorkspaceChange = 'edit' | 'clear' | 'replacement';

let peers: TestPeer[];
let recorders: TestRecorder[];
let downloads: Blob[];
let realtimeResponses: Array<() => Promise<Response>>;
let fileResponses: Array<() => Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let copyText: ReturnType<typeof vi.fn>;

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function streamFixture() {
  const track = { stop: vi.fn() };
  return {
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
    stop: track.stop
  };
}

function answer(): Response {
  return { ok: true, text: async () => 'synthetic answer' } as Response;
}

function response(text: string): Response {
  return {
    ok: true,
    json: async () => ({
      transcript: { text, language: 'en', model: 'gpt-4o-mini-transcribe', segments: [] }
    })
  } as Response;
}

function requestPath(input: RequestInfo | URL) {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return value.startsWith('/') ? value.split('?')[0] : new URL(value).pathname;
}

function fileCalls() {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/transcribe');
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
    const open = new Event('open');
    this.channel.onopen?.(open);
    this.channel.dispatchEvent(open);
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
    const data = new Event('dataavailable');
    Object.defineProperty(data, 'data', { value: new Blob(['synthetic audio']) });
    this.ondataavailable?.(data as BlobEvent);
    this.dispatchEvent(data);
    const stop = new Event('stop');
    this.onstop?.(stop);
    this.dispatchEvent(stop);
  }
}

function emit(peer: TestPeer, event: Record<string, unknown>) {
  act(() => peer.channel.emit(event));
}

function final(peer: TestPeer, itemId: string, text: string, previous?: string | null) {
  emit(peer, {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    event_id: `final-${itemId}`,
    ...(previous === undefined ? {} : { previous_item_id: previous }),
    transcript: text
  });
}

async function startLive() {
  realtimeResponses.push(() => Promise.resolve(answer()));
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Listening');
  return peers.at(-1)!;
}

async function startFallback() {
  realtimeResponses.push(() => Promise.reject(new TypeError('synthetic connection failure')));
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Recording locally');
  return recorders.at(-1)!;
}

async function stopRecorder(recorder: TestRecorder) {
  await act(async () => {
    recorder.emitStop();
    await Promise.resolve();
  });
}

async function changeWorkspace(change: WorkspaceChange) {
  if (change === 'edit') {
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'owned edit' } });
    return 'owned edit';
  }
  if (change === 'clear') {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    return '';
  }
  fileResponses.push(() => Promise.resolve(response('owned replacement')));
  fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
  fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
    target: { files: [new File(['synthetic audio'], 'replacement.mp3', { type: 'audio/mpeg' })] }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Transcript text')).toHaveValue('owned replacement')
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  return 'owned replacement';
}

async function downloaded(name: 'TXT' | 'JSON') {
  const before = downloads.length;
  fireEvent.click(screen.getByRole('button', { name }));
  expect(downloads).toHaveLength(before + 1);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(downloads.at(-1)!);
  });
}

async function expectSafeExports(orderResolved: boolean, editAccepted: boolean) {
  const displayed = (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
  expect(displayed).toContain('first');
  expect(displayed).toContain('second');
  if (editAccepted) expect(displayed).toContain('!');
  const safeText = (text: string) => {
    expect(text).toContain('first');
    expect(text).toContain('second');
    if (editAccepted) expect(text).toContain('!');
    if (!orderResolved || text.indexOf('first') > text.indexOf('second')) {
      expect(text).toMatch(
        /(?:order|chronolog).{0,30}(?:unconfirmed|uncertain|unknown|not confirmed)|(?:unconfirmed|uncertain|unknown|provisional).{0,30}(?:order|chronolog)/i
      );
    }
  };

  const copy = screen.getByRole('button', { name: 'Copy transcript' });
  if (copy.hasAttribute('disabled')) {
    const before = copyText.mock.calls.length;
    fireEvent.click(copy);
    expect(copyText).toHaveBeenCalledTimes(before);
  } else {
    fireEvent.click(copy);
    const copied = copyText.mock.calls.at(-1)?.[0] as string;
    expect(copied).toBe(displayed);
    safeText(copied);
  }
  for (const format of ['TXT', 'JSON'] as const) {
    if (screen.getByRole('button', { name: format }).hasAttribute('disabled')) {
      const before = downloads.length;
      fireEvent.click(screen.getByRole('button', { name: format }));
      expect(downloads).toHaveLength(before);
    } else {
      const exported = await downloaded(format);
      const text = format === 'JSON' ? (JSON.parse(exported).text as string) : exported;
      if (format === 'JSON') expect(text).toBe(displayed);
      else expect(text).toBe(displayed.endsWith('\n') ? displayed : `${displayed}\n`);
      safeText(text);
    }
  }
  if (
    ['Copy transcript', 'TXT', 'JSON'].some((name) =>
      screen.getByRole('button', { name }).hasAttribute('disabled')
    )
  ) {
    expect(document.body.textContent).toMatch(
      /(?:order|chronolog).{0,40}(?:unconfirmed|uncertain|unknown|provisional|not confirmed)|(?:unconfirmed|uncertain|unknown|provisional).{0,40}(?:order|chronolog)/i
    );
  }
}

beforeEach(() => {
  peers = [];
  recorders = [];
  downloads = [];
  realtimeResponses = [];
  fileResponses = [];
  getUserMedia = vi.fn(() => Promise.resolve(streamFixture().stream));
  copyText = vi.fn(async () => undefined);
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    const queue = path === '/api/realtime/call' ? realtimeResponses : fileResponses;
    const next = queue.shift();
    return next
      ? next()
      : Promise.reject(new Error(`Unexpected synthetic ${init?.method} request: ${path}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', TestPeer);
  vi.stubGlobal('MediaRecorder', TestRecorder);
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
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('unresolved chronology across a minor workspace edit', () => {
  it.each([true, false])(
    'protects Copy, TXT and JSON with late metadata: %s',
    async (lateMetadata) => {
      render(<SttApp />);
      const peer = await startLive();
      final(peer, 'B', 'second');
      final(peer, 'A', 'first');
      expect(screen.getByLabelText('Transcript text')).toHaveValue('second first');
      await expectSafeExports(false, false);

      const textarea = screen.getByLabelText('Transcript text') as HTMLTextAreaElement;
      const editingBlocked = textarea.readOnly || textarea.disabled;
      if (!editingBlocked) fireEvent.change(textarea, { target: { value: 'second first!' } });
      const editAccepted = textarea.value.includes('!');
      if (!editAccepted && !editingBlocked) {
        expect(document.body.textContent).toMatch(
          /edit.{0,60}(?:disabled|unavailable|until|resolv|order)|(?:order|chronolog).{0,60}edit/i
        );
      }
      await expectSafeExports(false, editAccepted);

      if (lateMetadata) {
        emit(peer, { type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
        await expectSafeExports(false, editAccepted);
        emit(peer, { type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
        await expectSafeExports(true, editAccepted);
      }
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await expectSafeExports(lateMetadata, editAccepted);
      const stoppedText = textarea.value;
      final(peer, 'stale', 'stale text', 'B');
      expect(textarea).toHaveValue(stoppedText);
      await expectSafeExports(lateMetadata, editAccepted);
    }
  );
});

describe('workspace ownership while live setup is pending', () => {
  it.each(
    (['microphone', 'SDP'] as const).flatMap((phase) =>
      (['edit', 'clear', 'replacement'] as const).map((change) => ({ phase, change }))
    )
  )('keeps a $change authoritative after pending $phase setup fails', async ({ phase, change }) => {
    const oldMedia = streamFixture();
    const newMedia = streamFixture();
    const pendingMedia = deferred<MediaStream>();
    const pendingSdp = deferred<Response>();
    if (phase === 'microphone') {
      getUserMedia.mockImplementationOnce(() => pendingMedia.promise);
      realtimeResponses.push(() => Promise.reject(new TypeError('synthetic SDP failure')));
    } else {
      getUserMedia.mockResolvedValueOnce(oldMedia.stream);
      realtimeResponses.push(() => pendingSdp.promise);
    }
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'original' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    if (phase === 'microphone') {
      await screen.findByText('Requesting microphone');
    } else {
      await waitFor(() => expect(peers).toHaveLength(1));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/realtime/call')
        ).toBe(true)
      );
    }
    const oldPeer = peers[0];
    const oldMessage = oldPeer?.channel.onmessage;
    const oldConnection = oldPeer?.onconnectionstatechange;
    const retained = await changeWorkspace(change);
    const callsBeforeFailure = fileCalls().length;
    fileResponses.push(() => Promise.resolve(response('fallback speech')));

    await act(async () => {
      if (phase === 'microphone') pendingMedia.resolve(oldMedia.stream);
      else pendingSdp.reject(new TypeError('synthetic SDP failure'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Starting' })).not.toBeInTheDocument()
    );
    expect(screen.getByLabelText('Transcript text')).toHaveValue(retained);

    const recorder = recorders.at(-1);
    const staleStop = recorder?.onstop;
    const notice = document.body.textContent ?? '';
    const autoTranscribes = /transcrib\w*\s+(?:after|on)\s+Stop/i.test(notice);
    const stillPromisesFence =
      /(?:transcription|session).{0,80}paused|stop and start.{0,30}new session/i.test(notice);
    if (recorder?.state === 'recording' && autoTranscribes) {
      expect(stillPromisesFence).toBe(false);
      expect(notice).toMatch(
        /(?:preserv|retain|append).{0,80}(?:workspace|transcript|text)|(?:workspace|transcript|text).{0,80}(?:preserv|retain|append)/i
      );
    }
    const stop = screen.getByRole('button', { name: 'Stop' });
    if (!stop.hasAttribute('disabled')) fireEvent.click(stop);
    if (recorder) await stopRecorder(recorder);
    const fallbackSent = fileCalls().length > callsBeforeFailure;
    if (fallbackSent) {
      expect(autoTranscribes).toBe(true);
      expect(stillPromisesFence).toBe(false);
      await waitFor(() =>
        expect(screen.getByLabelText('Transcript text')).toHaveValue(
          retained ? `${retained} fallback speech` : 'fallback speech'
        )
      );
    } else {
      expect(screen.getByLabelText('Transcript text')).toHaveValue(retained);
    }
    expect(oldMedia.stop).toHaveBeenCalled();

    const expectedBeforeNewSession = (
      screen.getByLabelText('Transcript text') as HTMLTextAreaElement
    ).value;
    realtimeResponses = [() => Promise.resolve(answer())];
    getUserMedia.mockResolvedValueOnce(newMedia.stream);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Listening');
    const newPeer = peers.at(-1)!;
    const priorCalls = fileCalls().length;
    act(() => {
      if (oldPeer && oldConnection) {
        oldPeer.connectionState = 'failed';
        oldConnection(new Event('connectionstatechange'));
        oldPeer.connectionState = 'connected';
        oldConnection(new Event('connectionstatechange'));
      }
      oldMessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'stale',
            previous_item_id: null,
            transcript: 'stale callback'
          })
        })
      );
      staleStop?.(new Event('stop'));
    });
    expect(newMedia.stop).not.toHaveBeenCalled();
    expect(fileCalls()).toHaveLength(priorCalls);
    expect(screen.getByLabelText('Transcript text')).toHaveValue(expectedBeforeNewSession);
    final(newPeer, 'new-session', 'fresh speech', null);
    expect(screen.getByLabelText('Transcript text')).toHaveValue(
      expectedBeforeNewSession ? `${expectedBeforeNewSession} fresh speech` : 'fresh speech'
    );
    const turn = screen.getByRole('button', { name: 'Finish turn' });
    expect(turn).toBeEnabled();
    fireEvent.click(turn);
    expect(newPeer.channel.send).toHaveBeenCalledOnce();
    expect(JSON.parse(newPeer.channel.send.mock.calls[0][0] as string)).toEqual({
      type: 'input_audio_buffer.commit',
      event_id: expect.any(String)
    });
    if (oldPeer) expect(oldPeer.channel.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(newMedia.stop).toHaveBeenCalled();
  });
});

describe('fallback cancellation disposition', () => {
  it.each(['edit', 'clear', 'replacement'] as const)(
    'distinguishes a discarded pre-upload recording after %s',
    async (change) => {
      render(<SttApp />);
      fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'original' } });
      const recorder = await startFallback();
      const retained = await changeWorkspace(change);
      const priorCalls = fileCalls().length;
      if (recorder.state === 'recording') {
        expect(document.body.textContent).toMatch(/transcrib\w*\s+(?:after|on)\s+Stop/i);
        expect(document.body.textContent).not.toMatch(/(?:will not|never) be transcribed/i);
        fileResponses.push(() => Promise.resolve(response('retained recording')));
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await stopRecorder(recorder);
        await waitFor(() => expect(fileCalls()).toHaveLength(priorCalls + 1));
        await waitFor(() =>
          expect(screen.getByLabelText('Transcript text')).toHaveValue(
            retained ? `${retained} retained recording` : 'retained recording'
          )
        );
      } else {
        expect(document.body.textContent).toMatch(
          /discard|without transcription|not be transcribed/i
        );
        await stopRecorder(recorder);
        expect(fileCalls()).toHaveLength(priorCalls);
        expect(screen.getByLabelText('Transcript text')).toHaveValue(retained);
      }
    }
  );

  it.each(['edit', 'clear', 'replacement'] as const)(
    'reports best-effort cancellation after the fallback upload is in flight and %s occurs',
    async (change) => {
      const pending = deferred<Response>();
      fileResponses.push(() => pending.promise);
      render(<SttApp />);
      fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'original' } });
      const recorder = await startFallback();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await stopRecorder(recorder);
      await waitFor(() => expect(fileCalls()).toHaveLength(1));
      const signal = fileCalls()[0][1]?.signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      let retained = '';
      try {
        retained = await changeWorkspace(change);
        expect(signal.aborted).toBe(true);
        const notices = Array.from(document.querySelectorAll('p, [role="alert"]')).map(
          (element) => element.textContent ?? ''
        );
        const disposition = notices.join(' ');
        expect(disposition).toMatch(/cancel|abort/i);
        expect(disposition).toMatch(
          /result.{0,60}(?:discard|ignor|not (?:be )?(?:used|applied))|(?:discard|ignor).{0,60}result/i
        );
        expect(disposition).toMatch(
          /(?:already|previously).{0,30}(?:sent|transmit|upload)|(?:sent|transmit|upload).{0,30}(?:already|before)/i
        );
        expect(disposition).toMatch(
          /(?:cannot|can't|could not|not possible to).{0,40}(?:retract|unsend|recall)|(?:may|might|could|still).{0,40}(?:transcrib|reach|process)|(?:not|cannot|can't).{0,40}(?:prevent|stop).{0,40}transcrib/i
        );
        expect(disposition).not.toMatch(/(?:will not|never) be transcribed/i);
      } finally {
        await act(async () => {
          pending.resolve(response('stale fallback result'));
          await pending.promise;
        });
      }
      expect(screen.getByLabelText('Transcript text')).toHaveValue(retained);
    }
  );

  it('still records and appends normally when no workspace fence intervenes', async () => {
    fileResponses.push(() => Promise.resolve(response('fallback speech')));
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'original' } });
    const recorder = await startFallback();
    expect(
      screen.getByText(/Recording locally in this tab and transcribing after Stop/i)
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await stopRecorder(recorder);
    await waitFor(() => expect(fileCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByLabelText('Transcript text')).toHaveValue('original fallback speech')
    );
  });
});
