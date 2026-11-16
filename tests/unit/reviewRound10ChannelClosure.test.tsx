import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';

type CloseSnapshot = {
  property: ((event: Event) => void) | null;
  listeners: EventListenerOrEventListenerObject[];
};

class TestTrack extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
}

function makeStream() {
  const track = new TestTrack();
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  } as unknown as MediaStream;
  return { stream, track };
}

type TestStream = ReturnType<typeof makeStream>;

class TestChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  private closeListeners = new Set<EventListenerOrEventListenerObject>();

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === 'close' && listener) this.closeListeners.add(listener);
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) {
    if (type === 'close' && listener) this.closeListeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  send = vi.fn((payload: string) => {
    if (this.readyState !== 'open' || typeof payload !== 'string') {
      throw new Error('Synthetic channel is not open for a text message');
    }
  });

  close = vi.fn(() => {
    this.readyState = 'closed';
  });

  snapshotClose(): CloseSnapshot {
    return { property: this.onclose, listeners: [...this.closeListeners] };
  }

  emit(data: Record<string, unknown>) {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.call(this, event);
    this.dispatchEvent(event);
  }
}

class TestPeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: ((event: Event) => void) | null = null;
  channel = new TestChannel();
  notifiedStates: RTCPeerConnectionState[] = [];
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'synthetic offer' }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => {
    this.channel.readyState = 'open';
    const open = new Event('open');
    this.channel.onopen?.call(this.channel, open);
    this.channel.dispatchEvent(open);
    this.connectionState = 'connected';
    this.notifiedStates.push(this.connectionState);
    const connected = new Event('connectionstatechange');
    this.onconnectionstatechange?.call(this, connected);
    this.dispatchEvent(connected);
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
  mimeType = 'audio/webm';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    const event = new Event('stop');
    this.onstop?.call(this, event);
    this.dispatchEvent(event);
  });

  constructor(public stream: MediaStream) {
    super();
    recorders.push(this);
  }
}

let peers: TestPeer[];
let recorders: TestRecorder[];
let streamQueue: TestStream[];
let answerQueue: Array<() => Promise<Response>>;
let unexpectedRequests: string[];
let unexpectedMediaRequests: number;
let downloads: Blob[];
let fetchMock: ReturnType<typeof makeFetch>;
let writeText: ReturnType<typeof makeWriteText>;

function requestPath(input: RequestInfo | URL) {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(value, 'https://synthetic.invalid').pathname;
}

function makeFetch() {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = requestPath(input);
    const method = init?.method || 'GET';
    const answer = path === '/api/realtime/call' && method === 'POST' ? answerQueue.shift() : null;
    if (answer) return answer();
    unexpectedRequests.push(`${method} ${path}`);
    return Promise.reject(new Error(`Unexpected synthetic request: ${method} ${path}`));
  });
}

function makeWriteText() {
  return vi.fn(async (value: string) => {
    if (typeof value !== 'string') throw new Error('Expected synthetic clipboard text');
  });
}

function queueSession() {
  const fixture = makeStream();
  streamQueue.push(fixture);
  answerQueue.push(() =>
    Promise.resolve({ ok: true, text: async () => 'synthetic answer' } as Response)
  );
  return fixture;
}

async function startSession(button: 'Start' | 'Retry' | HTMLElement) {
  const fixture = queueSession();
  const peerCount = peers.length;
  fireEvent.click(
    typeof button === 'string' ? screen.getByRole('button', { name: button }) : button
  );
  await waitFor(() => {
    expect(peers).toHaveLength(peerCount + 1);
    expect(peers[peerCount].connectionState).toBe('connected');
    expect(screen.getByText('Listening')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
  });
  return { fixture, peer: peers[peerCount] };
}

function livePanelText() {
  const panel = screen.getByRole('tab', { name: 'Live Mic' }).closest('.control-panel');
  if (!panel) throw new Error('Live controls are missing their visible panel');
  return panel.textContent || '';
}

function restartControl() {
  return screen
    .queryAllByRole('button', {
      name: /^(?:retry|start(?: again| (?:a )?new session)?|new session)$/i
    })
    .find((button) => !button.hasAttribute('disabled'));
}

function emit(peer: TestPeer, message: Record<string, unknown>) {
  act(() => peer.channel.emit(message));
}

function closeChannelOnly(peer: TestPeer) {
  expect(peer.connectionState).toBe('connected');
  expect(peer.channel.readyState).toBe('open');
  const snapshot = peer.channel.snapshotClose();
  expect(Boolean(snapshot.property) || snapshot.listeners.length > 0).toBe(true);
  const notifiedStates = [...peer.notifiedStates];
  act(() => {
    peer.channel.readyState = 'closed';
    const event = new Event('close');
    snapshot.property?.call(peer.channel, event);
    peer.channel.dispatchEvent(event);
  });
  expect(peer.notifiedStates).toEqual(notifiedStates);
  return snapshot;
}

function invokeSavedClose(channel: TestChannel, snapshot: CloseSnapshot) {
  const event = new Event('close');
  snapshot.property?.call(channel, event);
  snapshot.listeners.forEach((listener) => {
    if (typeof listener === 'function') listener.call(channel, event);
    else listener.handleEvent(event);
  });
  channel.dispatchEvent(event);
}

function sentTypes(channel: TestChannel) {
  return channel.send.mock.calls.map(([payload]) => {
    try {
      return (JSON.parse(payload) as { type?: unknown }).type;
    } catch {
      return undefined;
    }
  });
}

function expectSafeCapture(fixture: TestStream, notice: string) {
  if (fixture.track.stop.mock.calls.length) {
    expect(fixture.track.readyState).toBe('ended');
  } else if (!fixture.track.enabled) {
    expect(notice).toMatch(
      /(?:microphone|\bmic\b|capture|audio).{0,70}(?:paused|muted|disabled|off|stopped)|(?:paused|muted|disabled|stopped).{0,70}(?:microphone|\bmic\b|capture|audio)/i
    );
  } else {
    expect(
      recorders.some(
        (recorder) => recorder.stream === fixture.stream && recorder.state === 'recording'
      )
    ).toBe(true);
    expect(notice).toMatch(
      /(?:recording|recorded).{0,70}(?:locally|on (?:this|your) device|in (?:this|your) (?:tab|browser))|(?:locally|in (?:this|your) (?:tab|browser)).{0,70}recording/i
    );
    expect(notice).toMatch(/discard|choose|after stop|stop.{0,70}transcrib|transcrib.{0,70}stop/i);
  }
}

const uncertainOrder =
  /(?:order|chronolog).{0,50}(?:unconfirmed|uncertain|unknown|provisional|not confirmed)|(?:unconfirmed|uncertain|unknown|provisional).{0,50}(?:order|chronolog)/i;
const retainedPhrases = ['Accepted words', 'Pending alpha', 'Pending beta'];

function expectRetained(text: string) {
  retainedPhrases.forEach((phrase) => {
    expect(text.split(phrase)).toHaveLength(2);
  });
}

function blobText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const timeout = setTimeout(() => reject(new Error('Synthetic download read timed out')), 1000);
    reader.onload = () => {
      clearTimeout(timeout);
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      clearTimeout(timeout);
      reject(reader.error);
    };
    reader.readAsText(blob);
  });
}

async function expectRetainedWithoutInventedOrder() {
  const displayed = (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
  expectRetained(displayed);
  const copy = screen.getByRole('button', { name: 'Copy transcript' });
  const buttons = [
    copy,
    ...(['TXT', 'JSON'] as const).map((name) => screen.getByRole('button', { name }))
  ];
  if (buttons.some((button) => button.hasAttribute('disabled'))) {
    expect(`${displayed}\n${document.body.textContent || ''}`).toMatch(uncertainOrder);
  }
  if (!copy.hasAttribute('disabled')) {
    const count = writeText.mock.calls.length;
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(count + 1));
    const copied = writeText.mock.calls[count][0];
    expect(copied).toBe(displayed);
    expect(copied).toMatch(uncertainOrder);
  }
  for (const name of ['TXT', 'JSON'] as const) {
    const button = screen.getByRole('button', { name });
    if (!button.hasAttribute('disabled')) {
      const count = downloads.length;
      fireEvent.click(button);
      expect(downloads).toHaveLength(count + 1);
      const contents = await blobText(downloads[count]);
      const text = name === 'JSON' ? (JSON.parse(contents) as { text: string }).text : contents;
      expectRetained(text);
      expect(contents).toMatch(uncertainOrder);
    }
  }
}

beforeEach(() => {
  peers = [];
  recorders = [];
  streamQueue = [];
  answerQueue = [];
  unexpectedRequests = [];
  unexpectedMediaRequests = 0;
  downloads = [];
  fetchMock = makeFetch();
  writeText = makeWriteText();
  const getUserMedia = vi.fn((): Promise<MediaStream> => {
    const next = streamQueue.shift();
    if (next) return Promise.resolve(next.stream);
    unexpectedMediaRequests += 1;
    return Promise.reject(new Error('Unexpected synthetic microphone request'));
  });
  const navigatorFixture = Object.create(navigator);
  Object.defineProperties(navigatorFixture, {
    mediaDevices: { value: { getUserMedia }, configurable: true },
    clipboard: { value: { writeText }, configurable: true }
  });
  const NativeURL = URL;
  vi.stubGlobal('navigator', navigatorFixture);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', TestPeer);
  vi.stubGlobal('MediaRecorder', TestRecorder);
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
  const requests = [...unexpectedRequests];
  const mediaRequests = unexpectedMediaRequests;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(requests).toEqual([]);
  expect(mediaRequests).toBe(0);
});

describe('owned realtime channel closure', () => {
  it.each([false, true])(
    'reports and recovers a channel-only interruption with pending turn = %s',
    async (pendingTurn) => {
      render(<SttApp />);
      const { fixture, peer } = await startSession('Start');
      emit(peer, {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'accepted',
        previous_item_id: null,
        event_id: 'accepted-final',
        transcript: 'Accepted words'
      });
      emit(peer, {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'unknown-alpha',
        event_id: 'alpha-delta',
        delta: 'Pending alpha'
      });
      emit(peer, {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'unknown-beta',
        event_id: 'beta-delta',
        delta: 'Pending beta'
      });
      expectRetained((screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value);
      expect(screen.getByRole('button', { name: 'TXT' })).toBeDisabled();
      expect(fixture.track.stop).not.toHaveBeenCalled();
      expect(fixture.track.enabled).toBe(true);
      expect(sentTypes(peer.channel)).not.toContain('input_audio_buffer.commit');
      if (pendingTurn) {
        fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
        expect(sentTypes(peer.channel)).toEqual(['input_audio_buffer.commit']);
        expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
      }
      const commitsBefore = sentTypes(peer.channel).filter(
        (type) => type === 'input_audio_buffer.commit'
      ).length;

      const saved = closeChannelOnly(peer);
      await waitFor(() => {
        expect(screen.queryByText('Listening')).not.toBeInTheDocument();
        const notice = livePanelText();
        expect(notice).toMatch(/interrupt|disconnect|closed|lost|failed|unavailable/i);
        expect(notice).toMatch(
          /(?:audio|speech|turn|recording)[\s\S]{0,120}\b(?:may|might|could|not|lost|discarded|unconfirmed|uncertain|incomplete|repeat|unsent)\b|\b(?:lost|discarded|unconfirmed|uncertain|incomplete|unsent)\b[\s\S]{0,120}(?:audio|speech|turn|recording)/i
        );
        if (pendingTurn) {
          expect(notice).toMatch(
            /(?:audio|speech|turn|recording)[\s\S]{0,120}\b(?:may|might|could|unconfirmed|unknown|uncertain|incomplete|repeat)\b|\b(?:unconfirmed|unknown|uncertain|incomplete)\b[\s\S]{0,120}(?:audio|speech|turn|recording)/i
          );
        }
        expectSafeCapture(fixture, notice);
      });
      const closedFinish = screen.queryByRole('button', { name: 'Finish turn' });
      if (closedFinish) expect(closedFinish).toBeDisabled();
      await expectRetainedWithoutInventedOrder();
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        sentTypes(peer.channel).filter((type) => type === 'input_audio_buffer.commit')
      ).toHaveLength(commitsBefore);
      expect(sentTypes(peer.channel)).not.toContain('input_audio_buffer.append');

      if (!restartControl()) {
        expect(livePanelText()).toMatch(
          /stop[\s\S]{0,80}(?:retry|start)|(?:retry|start)[\s\S]{0,80}stop/i
        );
        expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      }
      const restart = restartControl();
      expect(restart).toBeDefined();
      if (!restart) throw new Error('No usable restart control after channel interruption');
      const replacement = await startSession(restart);
      expect(replacement.fixture.track.stop).not.toHaveBeenCalled();
      expect(replacement.fixture.track.enabled).toBe(true);
      expect(fixture.track.stop.mock.calls.length > 0 || !fixture.track.enabled).toBe(true);
      expect(
        recorders.filter(
          (recorder) => recorder.stream === fixture.stream && recorder.state === 'recording'
        )
      ).toHaveLength(0);
      expect(sentTypes(replacement.peer.channel)).not.toContain('input_audio_buffer.commit');
      expect(sentTypes(replacement.peer.channel)).not.toContain('input_audio_buffer.append');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expectRetainedWithoutInventedOrder();

      const displayed = (screen.getByLabelText('Transcript text') as HTMLTextAreaElement).value;
      const panelBefore = livePanelText();
      const alertsBefore = screen.queryAllByRole('alert').map((alert) => alert.textContent);
      const oldSends = peer.channel.send.mock.calls.length;
      const replacementSends = replacement.peer.channel.send.mock.calls.length;
      act(() => invokeSavedClose(peer.channel, saved));
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(replacement.peer.connectionState).toBe('connected');
      expect(replacement.peer.close).not.toHaveBeenCalled();
      expect(replacement.fixture.track.stop).not.toHaveBeenCalled();
      expect(replacement.fixture.track.enabled).toBe(true);
      expect(screen.getByText('Listening')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
      expect(livePanelText()).toBe(panelBefore);
      expect(screen.queryAllByRole('alert').map((alert) => alert.textContent)).toEqual(
        alertsBefore
      );
      expect(screen.getByLabelText('Transcript text')).toHaveValue(displayed);
      expect(peer.channel.send).toHaveBeenCalledTimes(oldSends);
      expect(replacement.peer.channel.send).toHaveBeenCalledTimes(replacementSends);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expectRetainedWithoutInventedOrder();
    },
    5000
  );

  it('ignores a stale close after replacement', { timeout: 5000 }, async () => {
    render(<SttApp />);
    const old = await startSession('Start');
    const saved = old.peer.channel.snapshotClose();
    expect(Boolean(saved.property) || saved.listeners.length > 0).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(old.fixture.track.stop).toHaveBeenCalled();
    const restart = restartControl();
    expect(restart).toBeDefined();
    if (!restart) throw new Error('No usable restart control after Stop');
    const current = await startSession(restart);
    emit(current.peer, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'current',
      previous_item_id: null,
      event_id: 'current-final',
      transcript: 'New session text'
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(sentTypes(current.peer.channel)).toEqual(['input_audio_buffer.commit']);
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    const oldSends = old.peer.channel.send.mock.calls.length;
    const currentSends = current.peer.channel.send.mock.calls.length;
    const requests = fetchMock.mock.calls.length;
    const recorderCount = recorders.length;
    const panelBefore = livePanelText();
    const alertsBefore = screen.queryAllByRole('alert').map((alert) => alert.textContent);

    act(() => invokeSavedClose(old.peer.channel, saved));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(current.peer.connectionState).toBe('connected');
    expect(current.peer.close).not.toHaveBeenCalled();
    expect(current.fixture.track.stop).not.toHaveBeenCalled();
    expect(current.fixture.track.enabled).toBe(true);
    expect(screen.getByText('Listening')).toBeVisible();
    expect(livePanelText()).toBe(panelBefore);
    expect(screen.queryAllByRole('alert').map((alert) => alert.textContent)).toEqual(alertsBefore);
    expect(screen.getByLabelText('Transcript text')).toHaveValue('New session text');
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    expect(old.peer.channel.send).toHaveBeenCalledTimes(oldSends);
    expect(current.peer.channel.send).toHaveBeenCalledTimes(currentSends);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    expect(recorders).toHaveLength(recorderCount);

    emit(current.peer, {
      type: 'input_audio_buffer.committed',
      event_id: 'new-turn-ack',
      item_id: 'new-turn',
      previous_item_id: 'current'
    });
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(sentTypes(current.peer.channel)).toEqual([
      'input_audio_buffer.commit',
      'input_audio_buffer.commit'
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it('commits on explicit Finish and cleans up on Stop', { timeout: 5000 }, async () => {
    render(<SttApp />);
    const { fixture, peer } = await startSession('Start');
    expect(peer.channel.send).not.toHaveBeenCalled();
    expect(fixture.track.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(peer.channel.send).toHaveBeenCalledOnce();
    const commit = JSON.parse(peer.channel.send.mock.calls[0][0]) as {
      type: string;
      event_id?: unknown;
    };
    expect(commit.type).toBe('input_audio_buffer.commit');
    if (commit.event_id !== undefined) {
      expect(typeof commit.event_id).toBe('string');
      expect((commit.event_id as string).length).toBeGreaterThan(0);
      expect((commit.event_id as string).length).toBeLessThanOrEqual(512);
    }
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(peer.channel.send).toHaveBeenCalledOnce();
    emit(peer, {
      type: 'input_audio_buffer.committed',
      event_id: 'turn-ack',
      item_id: 'turn',
      previous_item_id: null
    });
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(fixture.track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    expect(peer.channel.send).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(recorders.filter((recorder) => recorder.state === 'recording')).toHaveLength(0);
  });
});
