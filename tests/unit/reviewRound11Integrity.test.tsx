import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';
import type { TranscriptDocument } from '@/src/lib/transcriptExport';

type ServerEvent = Record<string, unknown>;
type ExpectedRequest = {
  url: string;
  response: () => Promise<Response>;
  language?: string;
  model?: string;
};
type ClientCommit = { type: string; event_id: string };

const defaultRealtimeModel = 'gpt-realtime-whisper';
const fileModel = 'gpt-4o-mini-transcribe';
const privateMarker = 'SYNTHETIC_PRIVATE_PROVIDER_DETAILS_11';
const uncertaintyPattern =
  /uncertain|unconfirmed|unverifi|unknown|(?:cannot|can't|could not|unable to) (?:be |safely )?(?:confirm|verif|determin|deduplic|identif)|(?:may|might|could).*(?:repeat|duplicat)|(?:repeat|duplicat).*(?:possible|may|unknown)/i;

let peers: TestPeer[];
let stops: ReturnType<typeof vi.fn>[];
let downloads: Blob[];
let requests: ExpectedRequest[];
let unexpected: string[];
let microphonesAllowed: number;
let recordersAllowed: number;
let clipboardWritesAllowed: number;
let downloadsAllowed: number;
let clipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

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

class TestRecorder {
  static isTypeSupported(type: string) {
    return type === 'audio/webm';
  }

  state: RecordingState = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    if (recordersAllowed < 1) {
      unexpected.push('Unexpected local recorder');
      throw new Error('Unexpected local recorder');
    }
    recordersAllowed -= 1;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['synthetic recording'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

function emit(channel: TestChannel, event: ServerEvent) {
  act(() => channel.emit(event));
}

function text() {
  return (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
}

function finishButton() {
  return screen.getByRole('button', { name: 'Finish turn' });
}

function finishTurn(channel: TestChannel) {
  const count = channel.send.mock.calls.length;
  expect(finishButton()).toBeEnabled();
  fireEvent.click(finishButton());
  expect(channel.send).toHaveBeenCalledTimes(count + 1);
  const commit = JSON.parse(channel.send.mock.calls[count][0]) as ClientCommit;
  expect(commit.type).toBe('input_audio_buffer.commit');
  expect(typeof commit.event_id).toBe('string');
  expect(commit.event_id.length).toBeGreaterThan(0);
  expect(commit.event_id.length).toBeLessThanOrEqual(512);
  expect(finishButton()).toBeDisabled();
  return commit;
}

function expectPending(channel: TestChannel, count: number) {
  expect(finishButton()).toBeDisabled();
  fireEvent.click(finishButton());
  expect(channel.send).toHaveBeenCalledTimes(count);
}

function notices() {
  return Array.from(document.querySelectorAll('[role="alert"], p'))
    .map((element) => element.textContent || '')
    .filter(Boolean);
}

function expectFence() {
  const notice = notices().find((value) =>
    /(?:paused|conflict|reused|invalid|malformed|limit)/i.test(value)
  );
  expect(notice).toBeDefined();
  expect(notice).toMatch(/stop|retry|start/i);
  expect(
    !screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled') ||
      !screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')
  ).toBe(true);
}

function unknownOutcomeNotice() {
  return notices().find(
    (value) => uncertaintyPattern.test(value) && /turn|commit|audio|result|outcome/i.test(value)
  );
}

function queueOffer(language = 'en', model: string | null = defaultRealtimeModel) {
  requests.push({
    url: `/api/realtime/call?language=${encodeURIComponent(language)}&delay=low`,
    response: async () =>
      new Response('v=0\r\n', {
        headers: model === null ? {} : { 'X-STT-Model': model }
      })
  });
}

function queueUpload(document: TranscriptDocument, language: string) {
  requests.push({
    url: '/api/transcribe',
    language,
    model: fileModel,
    response: async () =>
      new Response(JSON.stringify({ transcript: document }), {
        headers: { 'Content-Type': 'application/json' }
      })
  });
}

function selectLanguage(language: string) {
  fireEvent.change(screen.getByLabelText('Language hint'), { target: { value: language } });
}

async function startLive(language = 'en', model: string | null = defaultRealtimeModel) {
  microphonesAllowed += 1;
  queueOffer(language, model);
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Listening');
  return peers[peers.length - 1].channel;
}

async function upload(document: TranscriptDocument, language: string) {
  queueUpload(document, language);
  fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
  selectLanguage(language);
  fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
    target: { files: [new File(['synthetic audio'], 'fixture.mp3', { type: 'audio/mpeg' })] }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
  await waitFor(() => expect(text()).toBe(document.text));
}

async function readDownload(name: 'TXT' | 'JSON') {
  const count = downloads.length;
  downloadsAllowed += 1;
  fireEvent.click(screen.getByRole('button', { name }));
  expect(downloads).toHaveLength(count + 1);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(downloads[downloads.length - 1]);
  });
}

async function exportJson() {
  return JSON.parse(await readDownload('JSON')) as TranscriptDocument;
}

async function expectUncertainExportSafety() {
  const displayed = text();
  const visibleWarning = notices().some(
    (value) =>
      uncertaintyPattern.test(value) &&
      /partial|transcript|text|event|repeat|duplicat|identif|multiplic/i.test(value)
  );
  expect(visibleWarning || uncertaintyPattern.test(displayed)).toBe(true);
  for (const name of ['Copy transcript', 'TXT', 'JSON'] as const) {
    const button = screen.getByRole('button', { name });
    if (button.hasAttribute('disabled')) continue;
    expect(displayed).toMatch(uncertaintyPattern);
    if (name === 'Copy transcript') {
      clipboardWritesAllowed += 1;
      fireEvent.click(button);
      await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(displayed));
    } else {
      const result = await readDownload(name);
      const exported = name === 'JSON' ? (JSON.parse(result).text as string) : result;
      expect(exported).toContain(displayed);
      expect(exported).toMatch(uncertaintyPattern);
    }
  }
}

const audioAck = (item: string, event: string, previous: string | null = null): ServerEvent => ({
  type: 'input_audio_buffer.committed',
  event_id: event,
  item_id: item,
  previous_item_id: previous
});

const final = (item: string, event: string, transcript: string): ServerEvent => ({
  type: 'conversation.item.input_audio_transcription.completed',
  event_id: event,
  item_id: item,
  transcript
});

const mixedCreated = (item: string): ServerEvent => ({
  type: 'conversation.item.created',
  event_id: 'mixed-created',
  previous_item_id: null,
  item: { id: item, content: [{ type: 'input_text', text: 'typed' }, {}] }
});

const uploaded = (language: string, model = fileModel): TranscriptDocument => ({
  text: 'Uploaded speech',
  language,
  model,
  createdAt: '2026-01-01T00:00:00.000Z',
  segments: [{ start: 0, end: 1, text: 'Uploaded speech' }]
});

beforeEach(() => {
  peers = [];
  stops = [];
  downloads = [];
  requests = [];
  unexpected = [];
  microphonesAllowed = 0;
  recordersAllowed = 0;
  clipboardWritesAllowed = 0;
  downloadsAllowed = 0;
  clipboard = vi.fn<(value: string) => Promise<void>>(async () => {
    if (clipboardWritesAllowed < 1) {
      unexpected.push('Unexpected clipboard write');
      throw new Error('Unexpected clipboard write');
    }
    clipboardWritesAllowed -= 1;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const expected = requests.shift();
      if (!expected || path !== expected.url || init?.method !== 'POST') {
        unexpected.push(`Unexpected ${init?.method || 'GET'} ${path}`);
        return Promise.reject(new Error('Unexpected synthetic request'));
      }
      if (expected.language !== undefined) {
        const form = init.body;
        if (
          !(form instanceof FormData) ||
          form.get('language') !== expected.language ||
          form.get('model') !== expected.model ||
          !(form.get('file') instanceof File)
        ) {
          unexpected.push('Unexpected upload form');
          return Promise.reject(new Error('Unexpected synthetic form'));
        }
      }
      return expected.response();
    })
  );
  vi.stubGlobal('RTCPeerConnection', TestPeer);
  vi.stubGlobal('MediaRecorder', TestRecorder);
  const navigatorFixture = Object.create(navigator);
  Object.defineProperties(navigatorFixture, {
    mediaDevices: {
      value: {
        getUserMedia: vi.fn(async () => {
          if (microphonesAllowed < 1) {
            unexpected.push('Unexpected microphone request');
            throw new Error('Unexpected microphone request');
          }
          microphonesAllowed -= 1;
          const stop = vi.fn();
          stops.push(stop);
          const track = { stop };
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        })
      },
      configurable: true
    },
    clipboard: { value: { writeText: clipboard }, configurable: true }
  });
  vi.stubGlobal('navigator', navigatorFixture);
  const NativeURL = URL;
  vi.stubGlobal(
    'URL',
    Object.assign(class extends NativeURL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        if (downloadsAllowed < 1) {
          unexpected.push('Unexpected download');
          throw new Error('Unexpected download');
        }
        downloadsAllowed -= 1;
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
    expect(unexpected).toEqual([]);
    expect(requests).toEqual([]);
    expect(microphonesAllowed).toBe(0);
    expect(recordersAllowed).toBe(0);
    expect(clipboardWritesAllowed).toBe(0);
    expect(downloadsAllowed).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('round 11 public realtime identity', () => {
  it.each(['text first', 'pending audio first', 'resolved audio first'] as const)(
    'fences recognized text plus unknown content with %s',
    async (order) => {
      render(<SttApp />);
      const channel = await startLive();
      if (order === 'text first') emit(channel, mixedCreated('A'));
      emit(channel, audioAck('A', 'ack-A'));
      if (order === 'resolved audio first') emit(channel, final('A', 'final-A', 'accepted'));
      if (order !== 'text first') emit(channel, mixedCreated('A'));
      expectFence();
      const retained = text();
      if (order === 'resolved audio first') expect(retained).toContain('accepted');
      emit(channel, final('A', 'later-final', 'untrusted speech'));
      expect(text()).toBe(retained);
      expect(text()).not.toContain('untrusted speech');
    }
  );

  it.each(['unknown first', 'audio first'] as const)(
    'allows unknown-only metadata and valid audio: %s',
    async (order) => {
      render(<SttApp />);
      const channel = await startLive();
      const unknown = {
        type: 'conversation.item.created',
        event_id: 'unknown-created',
        previous_item_id: null,
        item: { id: 'A', content: [{}] }
      };
      if (order === 'unknown first') emit(channel, unknown);
      emit(channel, audioAck('A', 'ack-A'));
      if (order === 'audio first') emit(channel, unknown);
      emit(channel, final('A', 'final-A', 'valid speech'));
      expect(text()).toBe('valid speech');
      expect(await readDownload('TXT')).toBe('valid speech\n');
      expect((await exportJson()).text).toBe('valid speech');
    }
  );

  it('accepts a valid audio-only created item', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, {
      type: 'conversation.item.created',
      event_id: 'audio-created',
      previous_item_id: null,
      item: { id: 'A', content: [{ type: 'input_audio' }] }
    });
    emit(channel, audioAck('A', 'ack-A'));
    emit(channel, final('A', 'final-A', 'valid audio'));
    expect(text()).toBe('valid audio');
    expect((await exportJson()).text).toBe('valid audio');
  });

  it.each([false, true])(
    'does not settle a second turn with a fresh ACK for an already ACKed item (resolved=%s)',
    async (resolved) => {
      render(<SttApp />);
      const channel = await startLive();
      finishTurn(channel);
      emit(channel, audioAck('A', 'ack-A-1'));
      expect(finishButton()).toBeEnabled();
      if (resolved) emit(channel, final('A', 'final-A', 'first turn'));
      finishTurn(channel);
      emit(channel, audioAck('A', 'ack-A-2'));
      expectPending(channel, 2);
      expect(
        !screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled') ||
          !screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')
      ).toBe(true);
    }
  );

  it('allows a first ACK of a registered item and a distinct later ACK', async () => {
    render(<SttApp />);
    const channel = await startLive();
    finishTurn(channel);
    emit(channel, {
      type: 'input_audio_buffer.speech_started',
      event_id: 'started-A',
      item_id: 'A',
      previous_item_id: null
    });
    emit(channel, audioAck('A', 'ack-A'));
    expect(finishButton()).toBeEnabled();
    finishTurn(channel);
    emit(channel, audioAck('B', 'ack-B', 'A'));
    expect(finishButton()).toBeEnabled();
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { order: 'ignored first', tracked: 'ack' },
    { order: 'tracked first', tracked: 'ack' },
    { order: 'ignored first', tracked: 'transcript' },
    { order: 'tracked first', tracked: 'transcript' }
  ])('fences a $tracked collision with an ignored kind: $order', async ({ order, tracked }) => {
    render(<SttApp />);
    const channel = await startLive();
    const ignored = { type: 'rate_limits.updated', event_id: 'shared-id', rate_limits: [] };
    const trackedEvent =
      tracked === 'ack' ? audioAck('A', 'shared-id') : final('A', 'shared-id', 'spoken');
    if (order === 'ignored first') {
      emit(channel, ignored);
      finishTurn(channel);
      emit(channel, trackedEvent);
    } else {
      if (tracked === 'ack') finishTurn(channel);
      emit(channel, trackedEvent);
      if (tracked === 'ack') expect(finishButton()).toBeEnabled();
      finishTurn(channel);
      emit(channel, ignored);
    }
    expectPending(channel, tracked === 'ack' && order === 'tracked first' ? 2 : 1);
    expectFence();
    const retained = text();
    emit(channel, final('later', 'later-id', 'must not arrive'));
    expect(text()).toBe(retained);
  });

  it('bounds ignored IDs without disrupting distinct events', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, { type: 'rate_limits.updated', event_id: 'ordinary', rate_limits: [] });
    finishTurn(channel);
    emit(channel, audioAck('A', 'ack-A'));
    expect(finishButton()).toBeEnabled();
    act(() => {
      for (let index = 0; index < 4094; index += 1) {
        channel.emit({ type: 'rate_limits.updated', event_id: `ignored-${index}` });
      }
    });
    emit(channel, { type: 'rate_limits.updated', event_id: 'overflow' });
    expectFence();
  }, 15000);

  it('rejects an overlong item identity without accepting later speech', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, audioAck('x'.repeat(257), 'bounded-id'));
    expectFence();
    emit(channel, final('A', 'later', 'must not arrive'));
    expect(text()).not.toContain('must not arrive');
  });

  it('bounds item identity history without evicting earlier items', async () => {
    render(<SttApp />);
    const channel = await startLive();
    act(() => {
      for (let index = 0; index < 1024; index += 1) {
        channel.emit({
          type: 'conversation.item.created',
          previous_item_id: index === 0 ? null : `item-${index - 1}`,
          item: { id: `item-${index}`, content: [{ type: 'input_text', text: '' }] }
        });
      }
    });
    emit(channel, {
      type: 'conversation.item.created',
      previous_item_id: 'item-1023',
      item: { id: 'item-1024', content: [{ type: 'input_text', text: '' }] }
    });
    expectFence();
    emit(channel, final('item-0', 'after-limit', 'must not arrive'));
    expect(text()).not.toContain('must not arrive');
  }, 15000);
});

describe('unidentified partial safety', () => {
  it.each(['two equal utterance fragments', 'a repeated delivery'] as const)(
    'marks %s uncertain before export and lets a final replace it',
    async (caseName) => {
      render(<SttApp />);
      const channel = await startLive();
      emit(channel, audioAck('A', 'ack-A'));
      const delta = {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'A',
        delta: 'ha'
      };
      emit(channel, delta);
      emit(channel, caseName === 'a repeated delivery' ? delta : { ...delta });
      expect(text()).toContain('haha');
      await expectUncertainExportSafety();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
      emit(channel, final('A', 'authoritative-final', 'haha'));
      expect(text()).toBe('haha');
      expect(await readDownload('TXT')).toBe('haha\n');
      expect((await exportJson()).text).toBe('haha');
    }
  );

  it('retains uncertainty on Stop and rejects an old-session final', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const deliverOld = channel.savedDelivery();
    emit(channel, audioAck('A', 'ack-A'));
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      delta: 'ha'
    });
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      delta: 'ha'
    });
    await expectUncertainExportSafety();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(text()).toContain('haha');
    await expectUncertainExportSafety();
    const retained = text();
    act(() => deliverOld(final('A', 'late-final', 'old result')));
    expect(text()).toBe(retained);
  });

  it('still deduplicates an identified exact repeated event', async () => {
    render(<SttApp />);
    const channel = await startLive();
    emit(channel, audioAck('A', 'ack-A'));
    const delta = {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'identified-delta',
      item_id: 'A',
      delta: 'ha'
    };
    emit(channel, delta);
    emit(channel, delta);
    expect(text()).toBe('ha');
    expect(await readDownload('TXT')).toBe('ha\n');
  });
});

describe('turn error recovery', () => {
  it.each(['missing', 'unrelated', 'old'] as const)(
    'keeps the turn pending and offers safe recovery for a %s nested client ID',
    async (kind) => {
      const logs = [
        vi.spyOn(console, 'log'),
        vi.spyOn(console, 'warn'),
        vi.spyOn(console, 'error')
      ];
      render(<SttApp />);
      const channel = await startLive();
      const oldDelivery = channel.savedDelivery();
      const first = finishTurn(channel);
      emit(channel, audioAck('A', 'ack-A'));
      const pending = finishTurn(channel);
      expect(pending.event_id).not.toBe(first.event_id);
      emit(channel, {
        type: 'error',
        event_id: 'server-error',
        error: {
          ...(kind === 'missing'
            ? {}
            : { event_id: kind === 'old' ? first.event_id : 'unrelated-client-id' }),
          message: privateMarker,
          code: `${privateMarker}_CODE`,
          type: `${privateMarker}_TYPE`
        }
      });
      expectPending(channel, 2);
      const notice = unknownOutcomeNotice();
      expect(notice).toBeDefined();
      expect(notice).toMatch(/stop|retry|start/i);
      expect(notice).not.toContain(first.event_id);
      expect(notice).not.toContain(pending.event_id);
      expect(notice).not.toContain('unrelated-client-id');
      expect(document.body.textContent).not.toContain(privateMarker);
      logs.forEach((log) => expect(JSON.stringify(log.mock.calls)).not.toContain(privateMarker));
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(stops[0]).toHaveBeenCalledOnce();
      const replacement = await startLive();
      finishTurn(replacement);
      act(() => oldDelivery(audioAck('B', 'late-old-ack', 'A')));
      expectPending(replacement, 1);
      emit(replacement, audioAck('new', 'new-ack'));
      expect(finishButton()).toBeEnabled();
    }
  );

  it('accepts a later good ACK after an uncorrelated error', async () => {
    render(<SttApp />);
    const channel = await startLive();
    finishTurn(channel);
    emit(channel, {
      type: 'error',
      event_id: 'server-error',
      error: { message: privateMarker }
    });
    expectPending(channel, 1);
    expect(notices().some((value) => uncertaintyPattern.test(value))).toBe(true);
    emit(channel, audioAck('A', 'good-ack'));
    expect(finishButton()).toBeEnabled();
    expect(document.body.textContent).not.toContain(privateMarker);
  });

  it('does not mistake the outer server error ID for nested client correlation', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const pending = finishTurn(channel);
    emit(channel, {
      type: 'error',
      event_id: pending.event_id,
      error: { event_id: 'another-client-event', message: privateMarker }
    });
    expectPending(channel, 1);
    expect(unknownOutcomeNotice()).toBeDefined();
    expect(document.body.textContent).not.toContain(privateMarker);
  });

  it('uses the same fixed unknown-outcome guidance for different uncorrelated errors', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const first = finishTurn(channel);
    emit(channel, { type: 'error', event_id: 'error-1', error: { message: privateMarker } });
    const missingNotice = unknownOutcomeNotice();
    expect(missingNotice).toBeDefined();
    expectPending(channel, 1);
    emit(channel, audioAck('A', 'ack-A'));
    finishTurn(channel);
    emit(channel, {
      type: 'error',
      event_id: 'error-2',
      error: { event_id: 'unrelated-client-id', message: `${privateMarker}_2` }
    });
    expect(unknownOutcomeNotice()).toBe(missingNotice);
    expectPending(channel, 2);
    emit(channel, audioAck('B', 'ack-B', 'A'));
    finishTurn(channel);
    emit(channel, {
      type: 'error',
      event_id: 'error-3',
      error: { event_id: first.event_id, message: `${privateMarker}_3` }
    });
    expect(unknownOutcomeNotice()).toBe(missingNotice);
    expectPending(channel, 3);
    expect(document.body.textContent).not.toContain(privateMarker);
    expect(document.body.textContent).not.toContain('unrelated-client-id');
  });

  it('correlates only a matching nested client ID without leaking details', async () => {
    render(<SttApp />);
    const channel = await startLive();
    const first = finishTurn(channel);
    emit(channel, {
      type: 'error',
      event_id: 'different-server-id',
      error: { event_id: first.event_id, message: privateMarker }
    });
    expect(document.body.textContent).not.toContain(privateMarker);
    expect(
      notices().some((value) => /turn|audio/i.test(value) && /not|fail|retry/i.test(value))
    ).toBe(true);
    if (finishButton().hasAttribute('disabled')) {
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      const replacement = await startLive();
      finishTurn(replacement);
    } else {
      const retry = finishTurn(channel);
      expect(retry.event_id).not.toBe(first.event_id);
    }
  });
});

describe('source provenance and upload retention', () => {
  it.each([
    { uploadLanguage: 'auto', liveLanguage: 'auto', expected: undefined },
    { uploadLanguage: 'en', liveLanguage: 'auto', expected: undefined },
    { uploadLanguage: 'auto', liveLanguage: 'en', expected: undefined },
    { uploadLanguage: 'en', liveLanguage: 'en', expected: 'en' },
    { uploadLanguage: 'en', liveLanguage: 'fr', expected: undefined }
  ])(
    'combines upload $uploadLanguage and live $liveLanguage without inventing a language',
    async ({ uploadLanguage, liveLanguage, expected }) => {
      render(<SttApp />);
      await upload(uploaded(uploadLanguage), uploadLanguage);
      selectLanguage(liveLanguage);
      const channel = await startLive(liveLanguage);
      emit(channel, audioAck('A', 'ack-A'));
      emit(channel, final('A', 'final-A', 'Live speech'));
      const result = await exportJson();
      expect(result.text).toBe('Uploaded speech Live speech');
      expect(result.language).toBe(expected);
      expect(result.segments).toEqual([]);
    }
  );

  it.each([
    { uploadLanguage: 'auto', fallbackLanguage: 'auto', expected: undefined },
    { uploadLanguage: 'en', fallbackLanguage: 'auto', expected: undefined },
    { uploadLanguage: 'auto', fallbackLanguage: 'en', expected: undefined },
    { uploadLanguage: 'en', fallbackLanguage: 'en', expected: 'en' }
  ])(
    'combines upload $uploadLanguage and fallback $fallbackLanguage honestly',
    async ({ uploadLanguage, fallbackLanguage, expected }) => {
      render(<SttApp />);
      await upload(uploaded(uploadLanguage), uploadLanguage);
      selectLanguage(fallbackLanguage);
      microphonesAllowed += 1;
      recordersAllowed += 1;
      requests.push({
        url: `/api/realtime/call?language=${encodeURIComponent(fallbackLanguage)}&delay=low`,
        response: async () => {
          throw new Error('Synthetic realtime connection failure');
        }
      });
      queueUpload(
        { text: 'Fallback speech', language: fallbackLanguage, model: fileModel, segments: [] },
        fallbackLanguage
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await screen.findByText('Recording locally');
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => expect(text()).toBe('Uploaded speech Fallback speech'));
      const result = await exportJson();
      expect(result.language).toBe(expected);
      expect(result.segments).toEqual([]);
      expect(stops[0]).toHaveBeenCalledOnce();
    }
  );

  it('retains an edited workspace when an upload returns a sanitized non-success', async () => {
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'Edited workspace stays' }
    });
    requests.push({
      url: '/api/transcribe',
      language: 'en',
      model: fileModel,
      response: async () =>
        new Response(
          JSON.stringify({
            error: { code: 'UPSTREAM_ERROR', message: 'Transcription unavailable.' }
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        )
    });
    fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
    fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
      target: { files: [new File(['synthetic audio'], 'fixture.mp3', { type: 'audio/mpeg' })] }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
    await screen.findByText('Transcription unavailable.');
    expect(text()).toBe('Edited workspace stays');
    expect((await exportJson()).text).toBe('Edited workspace stays');
    expect(document.body.textContent).not.toContain(privateMarker);
  });

  it('allows a valid empty upload result to replace the workspace', async () => {
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'Previous workspace' }
    });
    await upload({ text: '', language: 'en', model: fileModel, segments: [] }, 'en');
    await screen.findByText('done');
    expect(text()).toBe('');
    expect(screen.getByRole('button', { name: 'TXT' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled();
  });

  it.each([
    { label: 'configured default', header: defaultRealtimeModel, expected: defaultRealtimeModel },
    {
      label: 'configured override',
      header: 'synthetic-realtime-override',
      expected: 'synthetic-realtime-override'
    },
    { label: 'missing', header: null, expected: undefined },
    { label: 'blank', header: ' ', expected: undefined },
    { label: 'overlong', header: 'x'.repeat(2048), expected: undefined }
  ])('uses $label response metadata for live-only JSON', async ({ header, expected }) => {
    render(<SttApp />);
    const channel = await startLive('en', header);
    emit(channel, audioAck('A', 'ack-A'));
    emit(channel, {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'delta-A',
      item_id: 'A',
      delta: 'Live'
    });
    expect((await exportJson()).model).toBe(expected);
    emit(channel, final('A', 'final-A', 'Live speech'));
    const result = await exportJson();
    expect(result.text).toBe('Live speech');
    expect(result.model).toBe(expected);
  });

  it.each([
    { header: fileModel, expected: fileModel },
    { header: 'synthetic-realtime-override', expected: 'mixed' },
    { header: null, expected: undefined },
    { header: ' ', expected: undefined }
  ])('uses selected $header model for combined provenance', async ({ header, expected }) => {
    render(<SttApp />);
    await upload(uploaded('en'), 'en');
    const channel = await startLive('en', header);
    emit(channel, audioAck('A', 'ack-A'));
    emit(channel, final('A', 'final-A', 'Live speech'));
    const result = await exportJson();
    expect(result.text).toBe('Uploaded speech Live speech');
    expect(result.model).toBe(expected);
    expect(result.segments).toEqual([]);
  });

  it.each(['synthetic-realtime-override', null])(
    'leaves an upload untouched when a %s session has no speech',
    async (header) => {
      render(<SttApp />);
      const original = uploaded('en');
      await upload(original, 'en');
      await startLive('en', header);
      expect(await exportJson()).toEqual(original);
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(await exportJson()).toEqual(original);
    }
  );

  it('uses fallback document provenance rather than a realtime model constant', async () => {
    render(<SttApp />);
    microphonesAllowed += 1;
    recordersAllowed += 1;
    requests.push({
      url: '/api/realtime/call?language=en&delay=low',
      response: async () => {
        throw new Error('Synthetic realtime connection failure');
      }
    });
    queueUpload(
      { text: 'Fallback speech', language: 'fr', model: 'synthetic-file-provenance', segments: [] },
      'en'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Recording locally');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(text()).toBe('Fallback speech'));
    const result = await exportJson();
    expect(result.model).toBe('synthetic-file-provenance');
    expect(result.language).toBe('fr');
  });
});
