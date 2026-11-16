import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

let peers: IntegrityPeer[];
let recorders: IntegrityRecorder[];
let downloads: Blob[];
let realtimeResponses: Array<() => Promise<Response>>;
let fileResponses: Array<() => Promise<Response>>;

const originalUpload = {
  text: 'Original uploaded text.',
  language: 'es',
  model: 'gpt-4o-mini-transcribe',
  segments: [{ start: 1, end: 2, text: 'Original uploaded text.' }]
};

function response(transcript: Record<string, unknown>): Response {
  return { ok: true, json: async () => ({ transcript }) } as Response;
}

function answer(): Response {
  return { ok: true, text: async () => 'synthetic answer' } as Response;
}

class IntegrityChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 'closed';
  });

  emit(event: Record<string, unknown>) {
    const message = new MessageEvent('message', { data: JSON.stringify(event) });
    this.onmessage?.(message);
    this.dispatchEvent(message);
  }
}

class IntegrityPeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: ((event: Event) => void) | null = null;
  channel = new IntegrityChannel();
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

class IntegrityRecorder extends EventTarget {
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

function emit(peer: IntegrityPeer, event: Record<string, unknown>) {
  act(() => peer.channel.emit(event));
}

function final(peer: IntegrityPeer, itemId: string, text: string, previous?: string | null) {
  emit(peer, {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    event_id: `final-${itemId}`,
    ...(previous === undefined ? {} : { previous_item_id: previous }),
    transcript: text
  });
}

function partial(peer: IntegrityPeer, itemId: string, text: string, previous: string | null) {
  emit(peer, {
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: itemId,
    event_id: `partial-${itemId}`,
    previous_item_id: previous,
    delta: text
  });
}

async function download(name: 'TXT' | 'JSON') {
  const count = downloads.length;
  fireEvent.click(screen.getByRole('button', { name }));
  expect(downloads).toHaveLength(count + 1);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(downloads.at(-1)!);
  });
}

async function upload(transcript: Record<string, unknown> & { text: string }) {
  fileResponses.push(() => Promise.resolve(response(transcript)));
  fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
  fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
    target: { files: [new File(['synthetic audio'], 'synthetic.mp3', { type: 'audio/mpeg' })] }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Transcript text')).toHaveValue(transcript.text)
  );
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

async function completeFallback(recorder: IntegrityRecorder, text: string) {
  fileResponses.push(() =>
    Promise.resolve(
      response({ text, language: 'en', model: 'gpt-4o-mini-transcribe', segments: [] })
    )
  );
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await act(async () => {
    recorder.emitStop();
    await Promise.resolve();
  });
  await screen.findByText('Stopped');
}

async function expectTextExports(text: string) {
  expect(screen.getByLabelText('Transcript text')).toHaveValue(text);
  expect(await download('TXT')).toBe(`${text}${text.endsWith('\n') ? '' : '\n'}`);
  const json = JSON.parse(await download('JSON'));
  expect(json.text).toBe(text);
  expect(json.segments).toEqual([]);
  expect(screen.getByRole('button', { name: 'SRT' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'VTT' })).toBeDisabled();
  return json;
}

beforeEach(() => {
  peers = [];
  recorders = [];
  downloads = [];
  realtimeResponses = [];
  fileResponses = [];
  const track = { stop: vi.fn() };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = value.startsWith('/') ? value.split('?')[0] : new URL(value).pathname;
      const next = (path === '/api/realtime/call' ? realtimeResponses : fileResponses).shift();
      return next ? next() : Promise.reject(new Error(`Unexpected synthetic request: ${path}`));
    })
  );
  vi.stubGlobal('RTCPeerConnection', IntegrityPeer);
  vi.stubGlobal('MediaRecorder', IntegrityRecorder);
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track]
        }))
      }
    })
  );
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

describe('fallback text and export integrity', () => {
  it.each(['edit', 'upload'] as const)(
    'appends successful fallback speech to an existing %s',
    async (source) => {
      render(<SttApp />);
      if (source === 'edit') {
        fireEvent.change(screen.getByLabelText('Transcript text'), {
          target: { value: 'Earlier edited text.' }
        });
      } else {
        await upload(originalUpload);
        expect(screen.getByRole('button', { name: 'SRT' })).toBeEnabled();
      }
      const recorder = await startFallback();
      await completeFallback(recorder, 'New recorded speech.');
      const earlier = source === 'edit' ? 'Earlier edited text.' : originalUpload.text;
      await expectTextExports(`${earlier} New recorded speech.`);
    }
  );

  it('retains an accepted final and a draft flushed by Stop before a later fallback', async () => {
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'Earlier edit' }
    });
    const peer = await startLive();
    final(peer, 'accepted', 'Accepted live', null);
    partial(peer, 'draft', 'Pending draft', 'accepted');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByLabelText('Transcript text')).toHaveValue(
      'Earlier edit Accepted live Pending draft'
    );
    const recorder = await startFallback();
    await completeFallback(recorder, 'Recorded speech');
    await expectTextExports('Earlier edit Accepted live Pending draft Recorded speech');
  });
});

describe('late ordering and contradictory identity', () => {
  it('reconciles late predecessor metadata before display and exports become final', async () => {
    render(<SttApp />);
    const peer = await startLive();
    final(peer, 'B', 'second');
    final(peer, 'B', 'second');
    final(peer, 'A', 'first');
    emit(peer, { type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('first second');
    expect(screen.getByText(/Live item order is unconfirmed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'TXT' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled();
    emit(peer, { type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    expect(screen.queryByText(/Live item order is unconfirmed/)).not.toBeInTheDocument();
    await expectTextExports('first second');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectTextExports('first second');
  });

  it('preserves both items with explicit order labels through Stop and exports', async () => {
    render(<SttApp />);
    const peer = await startLive();
    final(peer, 'B', 'second');
    final(peer, 'A', 'first');
    emit(peer, { type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('first second');
    expect(screen.getByText(/Live item order is unconfirmed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'TXT' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectTextExports(
      '[Live item; order unconfirmed]\nfirst\n\n[Live item; order unconfirmed]\nsecond'
    );
  });

  it.each(['pending audio first', 'resolved audio first', 'non-audio first'] as const)(
    'fences contradictory identity with %s',
    async (order) => {
      render(<SttApp />);
      const peer = await startLive();
      const nonAudio = {
        type: 'conversation.item.created',
        previous_item_id: null,
        item: { id: 'same-item', content: [{ type: 'input_text', text: 'not audio' }] }
      };
      if (order === 'pending audio first') partial(peer, 'same-item', 'audio draft', null);
      if (order === 'resolved audio first') final(peer, 'same-item', 'audio final', null);
      emit(peer, nonAudio);
      if (order === 'non-audio first') final(peer, 'same-item', 'contradictory audio', null);
      expect(screen.getByRole('alert')).toHaveTextContent(/paused|conflict|contradict/i);
      final(peer, 'later', 'must not be accepted', 'same-item');
      const expected =
        order === 'pending audio first'
          ? 'audio draft'
          : order === 'resolved audio first'
            ? 'audio final'
            : '';
      expect(screen.getByLabelText('Transcript text')).toHaveValue(expected);
    }
  );

  it('still fences conflicting reuse of an event ID while order is unresolved', async () => {
    render(<SttApp />);
    const peer = await startLive();
    emit(peer, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      event_id: 'same-event',
      delta: 'kept'
    });
    emit(peer, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'B',
      event_id: 'same-event',
      delta: 'reused'
    });
    final(peer, 'A', 'must not be accepted', null);
    expect(
      screen.getByText(
        'Live transcription paused: an event ID was reused with different identity or content. Stop and Start a new session.',
        { selector: '[role="alert"]' }
      )
    ).toBeVisible();
    expect(screen.getByLabelText('Transcript text')).toHaveValue('kept');
    expect(peer.close).not.toHaveBeenCalled();
  });

  it('still fences instead of evicting item identity after the documented item limit', async () => {
    render(<SttApp />);
    const peer = await startLive();
    act(() => {
      for (let index = 0; index <= 1024; index += 1) {
        peer.channel.emit({ type: 'input_audio_buffer.speech_started', item_id: `item-${index}` });
      }
    });
    expect(
      screen.getByText(
        'Live transcription paused: the session item limit was reached. Stop and Start a new session.',
        { selector: '[role="alert"]' }
      )
    ).toBeVisible();
    final(peer, 'item-0', 'must not be accepted', null);
    expect(screen.getByLabelText('Transcript text')).toHaveValue('');
    expect(peer.close).not.toHaveBeenCalled();
  });
});

describe('timestamp and provenance integrity', () => {
  const malformedSegments = [
    ['null item', null],
    ['missing times', { text: 'second' }],
    ['null times', { start: null, end: null, text: 'second' }],
    ['missing start', { end: 3, text: 'second' }],
    ['missing end', { start: 2, text: 'second' }],
    ['negative start', { start: -1, end: 3, text: 'second' }],
    ['reversed', { start: 3, end: 2, text: 'second' }],
    ['non-finite', { start: Number.POSITIVE_INFINITY, end: 3, text: 'second' }],
    ['NaN end', { start: 2, end: Number.NaN, text: 'second' }],
    ['missing text', { start: 2, end: 3 }],
    ['null text', { start: 2, end: 3, text: null }]
  ] as const;

  it.each(malformedSegments)('rejects a mixed segment list with %s', async (_description, bad) => {
    render(<SttApp />);
    await upload({
      text: 'first second',
      language: 'en',
      segments: [{ start: 1, end: 2, text: 'first' }, bad]
    });
    await expectTextExports('first second');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['non-array', { start: 1, end: 2, text: 'first second' }]
  ] as const)('safely handles a %s segment list', async (_description, segments) => {
    render(<SttApp />);
    await upload({ text: 'first second', language: 'en', segments });
    await expectTextExports('first second');
  });

  it('preserves an untouched upload and its original provenance when live starts without speech', async () => {
    render(<SttApp />);
    await upload(originalUpload);
    const before = JSON.parse(await download('JSON'));
    expect(before).toMatchObject(originalUpload);
    const beforeTxt = await download('TXT');
    await startLive();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await download('TXT')).toBe(beforeTxt);
    expect(JSON.parse(await download('JSON'))).toEqual(before);
    expect(screen.getByRole('button', { name: 'SRT' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'VTT' })).toBeEnabled();
  });

  it('does not claim mixed uploaded and live text came solely from either model', async () => {
    render(<SttApp />);
    await upload(originalUpload);
    const peer = await startLive();
    final(peer, 'speech', 'Live addition.', null);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const json = await expectTextExports('Original uploaded text. Live addition.');
    expect(json.model).not.toBe('gpt-4o-mini-transcribe');
    expect(json.model).not.toBe('gpt-realtime-whisper');
  });

  it.each([
    ['synthetic-selected', 'synthetic-selected'],
    ['synthetic-file', 'mixed'],
    [undefined, undefined]
  ] as const)(
    'carries session model through fallback with file model %s',
    async (fileModel, expected) => {
      let rejectAnswer!: (reason: Error) => void;
      const pendingAnswer = new Promise<string>((_resolve, reject) => {
        rejectAnswer = reject;
      });
      const answerText = vi.fn(() => pendingAnswer);
      const delayedAnswer = new Response('', {
        headers: { 'X-STT-Model': 'synthetic-selected' }
      });
      Object.defineProperty(delayedAnswer, 'text', { value: answerText });
      realtimeResponses.push(() => Promise.resolve(delayedAnswer));
      render(<SttApp />);
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => expect(answerText).toHaveBeenCalledOnce());
      partial(peers[0], 'pending', 'Retained speech', null);
      fileResponses.push(() =>
        Promise.resolve(
          response({
            text: 'Fallback speech',
            language: 'en',
            model: fileModel,
            segments: []
          })
        )
      );
      await act(async () => {
        rejectAnswer(new Error('synthetic SDP interruption'));
        await pendingAnswer.catch(() => undefined);
      });
      await screen.findByText('Recording locally');
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await act(async () => {
        recorders[0].emitStop();
        await Promise.resolve();
      });
      await screen.findByText('Stopped');
      const json = await expectTextExports('Retained speech Fallback speech');
      expect(json.model).toBe(expected);
    }
  );

  it('uses the language captured at each live session start for drafts and final text', async () => {
    render(<SttApp />);
    const firstPeer = await startLive();
    partial(firstPeer, 'english', 'English draft', null);
    fireEvent.change(screen.getByLabelText('Language hint'), { target: { value: 'es' } });
    expect((await expectTextExports('English draft')).language).toBe('en');
    final(firstPeer, 'english', 'English final', null);
    expect((await expectTextExports('English final')).language).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect((await expectTextExports('English final')).language).toBe('en');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    realtimeResponses.push(() => Promise.resolve(answer()));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Listening');
    const secondPeer = peers.at(-1)!;
    partial(secondPeer, 'spanish', 'Spanish draft', null);
    fireEvent.change(screen.getByLabelText('Language hint'), { target: { value: 'fr' } });
    expect((await expectTextExports('Spanish draft')).language).toBe('es');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect((await expectTextExports('Spanish draft')).language).toBe('es');
  });

  it('preserves exact leading and multiline whitespace during draft, final, and Stop', async () => {
    const previousText = '  heading\n\n  body';
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: previousText } });
    const peer = await startLive();
    partial(peer, 'speech', 'draft', null);
    await expectTextExports(`${previousText} draft`);
    final(peer, 'speech', 'final', null);
    await expectTextExports(`${previousText} final`);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await expectTextExports(`${previousText} final`);
  });
});
