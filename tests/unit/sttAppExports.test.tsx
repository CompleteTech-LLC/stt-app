import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';
import type { TranscriptDocument } from '@/src/lib/transcriptExport';

const uploadedTranscript: TranscriptDocument = {
  text: 'Original transcript.',
  language: 'en',
  model: 'gpt-4o-mini-transcribe',
  createdAt: '2026-06-10T00:00:00.000Z',
  segments: [{ start: 1.001, end: 2.5, text: 'Original transcript.' }]
};

let downloads: Blob[];
let channel: { onmessage: ((message: { data: string }) => void) | null };
let stopTrack: ReturnType<typeof vi.fn>;
let automaticItemId: number;

const getExportButton = (name: string) => screen.getByRole('button', { name });

async function readDownload(name: string) {
  const count = downloads.length;
  fireEvent.click(getExportButton(name));
  expect(downloads).toHaveLength(count + 1);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(downloads.at(-1)!);
  });
}

async function uploadTranscript() {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ transcript: uploadedTranscript }), {
      headers: { 'Content-Type': 'application/json' }
    })
  );
  fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
  fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
    target: { files: [new File(['synthetic audio'], 'sample.mp3', { type: 'audio/mpeg' })] }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
  await screen.findByText('done');
  await waitFor(() =>
    expect(screen.getByLabelText('Transcript text')).toHaveValue(uploadedTranscript.text)
  );
}

async function startLive() {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('synthetic answer'));
  fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Listening');
}

function stubMediaRecorder() {
  vi.stubGlobal(
    'MediaRecorder',
    class {
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.();
      }
    }
  );
}

function emitTranscript(type: 'delta' | 'completed', text: string, itemId?: string) {
  const id = itemId ?? `automatic-item-${automaticItemId}`;
  if (itemId === undefined && type === 'completed') automaticItemId++;
  act(() => {
    channel.onmessage?.({
      data: JSON.stringify({
        type: `conversation.item.input_audio_transcription.${type}`,
        item_id: id,
        ...(type === 'delta' ? { delta: text } : { transcript: text })
      })
    });
  });
}

function emitEvent(event: Record<string, unknown>) {
  act(() => channel.onmessage?.({ data: JSON.stringify(event) }));
}

beforeEach(() => {
  downloads = [];
  channel = { onmessage: null };
  stopTrack = vi.fn();
  automaticItemId = 0;
  const track = { stop: stopTrack };
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      connectionState = 'connected';
      onconnectionstatechange: (() => void) | null = null;
      createDataChannel = () => channel;
      addTrack = vi.fn();
      createOffer = async () => ({ type: 'offer', sdp: 'synthetic offer' });
      setLocalDescription = vi.fn();
      setRemoteDescription = async () => this.onconnectionstatechange?.();
      close = vi.fn();
    }
  );
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn((blob: Blob) => {
      downloads.push(blob);
      return 'blob:synthetic-download';
    }),
    revokeObjectURL: vi.fn()
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [track],
          getTracks: () => [track]
        })
      }
    })
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('transcript export controls', () => {
  it('exports the original uploaded text and timestamped subtitles', async () => {
    render(<SttApp />);
    await uploadTranscript();

    expect(await readDownload('TXT')).toBe('Original transcript.\n');
    expect(JSON.parse(await readDownload('JSON'))).toEqual(uploadedTranscript);
    expect(await readDownload('SRT')).toContain(
      '00:00:01,001 --> 00:00:02,500\nOriginal transcript.'
    );
    expect(await readDownload('VTT')).toContain(
      '00:00:01.001 --> 00:00:02.500\nOriginal transcript.'
    );
  });

  it('exports edits without stale JSON segments and disables subtitles', async () => {
    render(<SttApp />);
    await uploadTranscript();
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'Corrected transcript.' }
    });

    expect(await readDownload('TXT')).toBe('Corrected transcript.\n');
    expect(JSON.parse(await readDownload('JSON'))).toEqual({
      ...uploadedTranscript,
      text: 'Corrected transcript.',
      segments: []
    });
    expect(getExportButton('SRT')).toBeDisabled();
    expect(getExportButton('VTT')).toBeDisabled();
    expect(getExportButton('SRT')).toHaveAccessibleDescription(/Editing text.*removes/);

    // Returning to the original text does not invent a new timing alignment.
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: uploadedTranscript.text }
    });
    expect(getExportButton('SRT')).toBeDisabled();
    await uploadTranscript();
    expect(getExportButton('SRT')).toBeEnabled();
  });

  it('exports live drafts, finalized text, and stopped-session edits as TXT/JSON', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'Live draft');

    expect(await readDownload('TXT')).toBe('Live draft\n');
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: 'Live draft',
      segments: []
    });
    expect(getExportButton('SRT')).toBeDisabled();
    expect(getExportButton('VTT')).toBeDisabled();

    emitTranscript('completed', 'Final live text.');
    expect(await readDownload('TXT')).toBe('Final live text.\n');
    emitTranscript('delta', 'Still speaking');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: 'Final live text. Still speaking',
      segments: []
    });
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'Edited live transcript.' }
    });
    expect(await readDownload('TXT')).toBe('Edited live transcript.\n');
    expect(JSON.parse(await readDownload('JSON')).segments).toEqual([]);
  });

  it('exports successive live utterances as the second draft becomes final', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'First sentence.');
    emitTranscript('delta', 'Second');
    emitTranscript('delta', ' sentence');

    expect(await readDownload('TXT')).toBe('First sentence. Second sentence\n');
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: 'First sentence. Second sentence',
      segments: []
    });

    emitTranscript('completed', 'Second sentence corrected.');
    expect(await readDownload('TXT')).toBe('First sentence. Second sentence corrected.\n');
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: 'First sentence. Second sentence corrected.',
      segments: []
    });
  });

  it('invalidates uploaded timing when live text is appended, including pending drafts', async () => {
    render(<SttApp />);
    await uploadTranscript();
    await startLive();
    emitTranscript('delta', 'New draft');

    expect(getExportButton('SRT')).toBeDisabled();
    expect(getExportButton('VTT')).toBeDisabled();
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: 'Original transcript. New draft',
      segments: []
    });
    emitTranscript('completed', 'New live text.');
    expect(await readDownload('TXT')).toBe('Original transcript. New live text.\n');
    expect(JSON.parse(await readDownload('JSON')).segments).toEqual([]);
    expect(getExportButton('SRT')).toBeDisabled();
  });

  it('replaces a pending live draft when a file transcription arrives', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'Old live draft');
    await uploadTranscript();

    expect(await readDownload('TXT')).toBe('Original transcript.\n');
    expect(JSON.parse(await readDownload('JSON'))).toEqual(uploadedTranscript);
    expect(getExportButton('SRT')).toBeEnabled();
    expect(getExportButton('VTT')).toBeEnabled();
    emitTranscript('delta', ' continued');
    emitTranscript('completed', 'Old live draft continued');
    expect(JSON.parse(await readDownload('JSON'))).toEqual(uploadedTranscript);
    emitTranscript('completed', 'Next utterance.');
    expect(await readDownload('TXT')).toBe('Original transcript.\n');
    expect(screen.getByRole('alert')).toHaveTextContent(/workspace changed.*Stop and Start/);
    fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await startLive();
    emitTranscript('completed', 'Next utterance.');
    expect(await readDownload('TXT')).toBe('Original transcript. Next utterance.\n');
  });

  it('keeps edits to a live draft when its remaining events arrive', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'Draft words');
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'Corrected words' }
    });
    emitTranscript('delta', ' more');
    emitTranscript('completed', 'Draft words more');
    expect(await readDownload('TXT')).toBe('Corrected words\n');
    emitTranscript('delta', 'Next');
    emitTranscript('completed', 'Next sentence.');
    expect(await readDownload('TXT')).toBe('Corrected words\n');
    expect(screen.getByRole('alert')).toHaveTextContent(/workspace changed/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await startLive();
    emitTranscript('completed', 'Next sentence.');
    expect(await readDownload('TXT')).toBe('Corrected words Next sentence.\n');
  });

  it('does not restore a cleared draft when its completion arrives', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'Discard me');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    emitTranscript('completed', 'Discard me');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('');
    emitTranscript('completed', 'New text');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent(/workspace changed/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await startLive();
    emitTranscript('completed', 'New text');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('New text');
  });

  it('ignores queued live events after stopping and keeps a just-received draft', async () => {
    render(<SttApp />);
    await startLive();
    act(() => {
      channel.onmessage?.({
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: 'queued-item',
          delta: 'Last draft'
        })
      });
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });
    emitTranscript('completed', 'Last draft');
    emitTranscript('delta', ' late');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('Last draft');
  });

  it('disables every export when the workspace is cleared', async () => {
    render(<SttApp />);
    await uploadTranscript();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    for (const format of ['TXT', 'JSON', 'SRT', 'VTT']) {
      expect(getExportButton(format)).toBeDisabled();
    }
  });
});

describe('cancelled microphone startup', () => {
  it('stops a stream acquired after Stop without opening a connection', async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(pending);
    const connection = vi.fn();
    vi.stubGlobal('RTCPeerConnection', connection);
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(async () => {
      resolveStream({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
      await pending;
    });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(connection).not.toHaveBeenCalled();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });
});

describe('identified live items', () => {
  it.each([
    { description: 'empty', content: [] },
    { description: 'absent', content: undefined },
    { description: 'unknown', content: [{ type: 'unknown' }] },
    { description: 'contradictory text', content: [{ type: 'input_text' }] },
    { description: 'mixed text and unknown', content: [{ type: 'input_text' }, {}] }
  ])('keeps known audio when created content is $description', async ({ content }) => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'A' });
    emitTranscript('delta', 'spoken draft', 'A');
    emitEvent({ type: 'conversation.item.created', item: { id: 'A', content } });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('spoken draft');
    emitTranscript('completed', 'spoken final', 'A');
    expect(await readDownload('TXT')).toBe('spoken final\n');
  });

  it('registers available predecessors even when created content is absent', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: 'A',
      item: { id: 'B' }
    });
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    expect(await readDownload('TXT')).toBe('first second\n');
  });

  it('keeps known direct predecessors adjacent when other drafts overlap', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'first', 'A');
    emitTranscript('delta', 'other', 'X');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitTranscript('completed', 'other', 'X');
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    expect(await readDownload('TXT')).toBe('first second other\n');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('orders an explicitly first item before pending items with unknown predecessors', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'second', 'B');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitTranscript('delta', 'first', 'A');
    expect(await readDownload('TXT')).toBe('first second\n');
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    expect(await readDownload('TXT')).toBe('first second\n');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('fences first-item metadata that contradicts committed text', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'later', 'A');
    emitTranscript('delta', 'first', 'B');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: null });
    expect(screen.getByRole('alert')).toHaveTextContent(/first-item metadata.*committed/);
    expect(await readDownload('TXT')).toBe('later first\n');
    emitTranscript('completed', 'changed', 'B');
    expect(await readDownload('TXT')).toBe('later first\n');
  });

  it('preserves the displayed order when an oversized update also carries predecessor metadata', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'first', 'A');
    emitTranscript('delta', 'second', 'B');
    emitEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      previous_item_id: 'B',
      delta: 'x'.repeat(1_000_000)
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/pending text limit/);
    expect(await readDownload('TXT')).toBe('first second\n');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await readDownload('TXT')).toBe('first second\n');
  });

  it('surfaces conflicting final or failure events without replacing accepted text', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'first', 'A');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'B',
      event_id: 'first-final',
      transcript: 'second'
    });
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'B',
      event_id: 'conflicting-final',
      transcript: 'different'
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/terminal item.*conflicting/);
    expect(await readDownload('TXT')).toBe('first second\n');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await readDownload('TXT')).toBe('first second\n');
    await startLive();
    emitTranscript('completed', 'accepted', 'C');
    emitEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'C' });
    expect(screen.getByRole('alert')).toHaveTextContent(/terminal item.*conflicting/);
    expect(await readDownload('TXT')).toBe('first second accepted\n');
  });

  it('releases successors after a failed predecessor and visibly reports the failure', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'partial first', 'A');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitTranscript('completed', 'second', 'B');
    emitEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'A',
      event_id: 'failure-event',
      error: { message: 'synthetic provider detail' }
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/failed transcription.*incomplete/);
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'C',
      previous_item_id: 'B',
      transcript: 'third'
    });
    expect(await readDownload('TXT')).toBe('partial first second third\n');
    expect(screen.queryByText(/synthetic provider detail/)).not.toBeInTheDocument();
  });

  it('releases successors when an unregistered predecessor fails without text', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitTranscript('completed', 'second', 'B');
    emitEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'A' });
    expect(screen.getByRole('alert')).toHaveTextContent(/failed transcription/);
    expect(await readDownload('TXT')).toBe('second\n');
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'C',
      previous_item_id: 'B',
      transcript: 'third'
    });
    expect(await readDownload('TXT')).toBe('second third\n');
  });

  it('preserves a buffered draft when retry replaces an interrupted tracker', async () => {
    let disconnect = () => {};
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        connectionState = 'connected';
        onconnectionstatechange: (() => void) | null = null;
        createDataChannel = () => channel;
        addTrack = vi.fn();
        createOffer = async () => ({ type: 'offer', sdp: 'synthetic offer' });
        setLocalDescription = vi.fn();
        setRemoteDescription = async () => {
          this.onconnectionstatechange?.();
          disconnect = () => {
            this.connectionState = 'disconnected';
            this.onconnectionstatechange?.();
          };
        };
        close = vi.fn();
      }
    );
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitTranscript('completed', 'buffered second', 'B');
    act(disconnect);
    expect(screen.getByText('Realtime unavailable')).toBeInTheDocument();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('synthetic answer'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Listening');
    expect(await readDownload('TXT')).toBe('buffered second\n');
  });

  it('does not report an active-session fence after startup fails', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new Error('microphone blocked')
    );
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/microphone blocked/);
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'saved' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await readDownload('TXT')).toBe('saved\n');
  });

  it('does not report an active-session fence after successful fallback transcription', async () => {
    stubMediaRecorder();
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transcript: { ...uploadedTranscript, text: 'fallback' } }))
      );
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/Recording locally in this tab/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByLabelText('Transcript text')).toHaveValue('fallback'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await readDownload('TXT')).toBe('fallback\n');
  });

  it('does not report an active-session fence after fallback transcription fails', async () => {
    stubMediaRecorder();
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('fallback failed'));
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText(/Recording locally in this tab/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('fallback failed');
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'saved' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await readDownload('TXT')).toBe('saved\n');
  });

  it.each(['clear', 'edit', 'replace'] as const)(
    'fences unregistered and later-described predecessors after %s',
    async (action) => {
      render(<SttApp />);
      await startLive();
      emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
      emitEvent({ type: 'input_audio_buffer.committed', item_id: 'C', previous_item_id: 'B' });
      emitTranscript('delta', 'second', 'B');
      emitTranscript('delta', 'third', 'C');
      if (action === 'clear') fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      if (action === 'edit')
        fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'Edited' } });
      if (action === 'replace') await uploadTranscript();
      emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: 'older' });
      emitTranscript('completed', 'older', 'older');
      emitTranscript('completed', 'first', 'A');
      emitTranscript('completed', 'second', 'B');
      emitTranscript('completed', 'third', 'C');
      emitTranscript('completed', 'ambiguous new', 'new');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        action === 'clear' ? '' : action === 'edit' ? 'Edited' : 'Original transcript.'
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/workspace changed.*Stop and Start/);
      if (action === 'clear') expect(getExportButton('TXT')).toBeDisabled();
      else {
        expect(await readDownload('TXT')).toBe(
          action === 'edit' ? 'Edited\n' : 'Original transcript.\n'
        );
      }
    }
  );

  it('refuses identity-free and mixed-ID text instead of correlating by event ID', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'identified draft', 'A');
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'different-event',
      transcript: 'anonymous final'
    });
    emitTranscript('completed', 'identified final', 'A');
    emitTranscript('completed', 'another item', 'B');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('identified draft');
    expect(screen.getByRole('alert')).toHaveTextContent(/item ID.*Stop and Start/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await readDownload('TXT')).toBe('identified draft\n');
    await startLive();
    emitTranscript('completed', 'new session', 'B');
    expect(await readDownload('TXT')).toBe('identified draft new session\n');
  });

  it('refuses an anonymous draft and later identified completion without guessing', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'event-not-item',
      delta: 'unidentified'
    });
    emitTranscript('completed', 'identified final', 'A');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent(/item ID/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/item ID/);
  });

  it.each([
    { type: 'conversation.item.input_audio_transcription.delta', item_id: 'A' },
    { type: 'input_audio_buffer.speech_started', item_id: 42 },
    { type: 'conversation.item.created' },
    {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      event_id: { bad: true },
      delta: 'bad'
    },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'A', delta: 'bad' },
    {
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'A',
      delta: 'bad'
    },
    {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      delta: 'bad',
      transcript: 'also bad'
    },
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'A',
      delta: 'bad',
      transcript: 'also bad'
    },
    {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      item: { content: [{ transcript: 'not a final' }] }
    },
    {
      type: 'conversation.item.input_audio_transcription.unrecognized',
      item_id: 'A',
      transcript: 'not a final'
    },
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'A',
      item: { id: 'B' },
      transcript: 'conflicting'
    },
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'A',
      item: { id: 'A', content: [{ type: 'input_audio', transcript: 'different' }] },
      transcript: 'one'
    },
    { type: 'input_audio_buffer.committed', item_id: 'A', transcript: 'unexpected text' },
    {
      type: 'conversation.item.created',
      item: { id: 'A', content: [{ type: 'input_audio', transcript: 'unexpected text' }] }
    },
    {
      type: 'conversation.item.created',
      item: { id: 'A', content: { type: 'input_audio', transcript: 'unexpected text' } }
    },
    {
      type: 'conversation.item.created',
      item: { id: 'A', content: [{ type: 'input_audio', text: 'unexpected text' }] }
    },
    {
      type: 'input_audio_buffer.committed',
      item_id: 'A',
      item: { id: 'A', content: [{ type: 'input_audio', transcript: 'unexpected text' }] }
    },
    { type: 'unrecognized.event', nested: { transcript: 'unexpected text' } },
    { type: 'unrecognized.event', item_id: 'A', transcript: 'unexpected text' }
  ])('refuses malformed or conflicting identity event %# visibly', async (event) => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'saved', 'saved');
    emitEvent(event);
    emitTranscript('completed', 'not accepted', 'saved');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('saved');
    expect(screen.getByRole('alert')).toHaveTextContent(/Live transcription paused/);
  });

  it.each(['not-json', 'x'.repeat(1_100_001)])(
    'fences malformed or oversized raw realtime data',
    async (data) => {
      render(<SttApp />);
      await startLive();
      emitTranscript('delta', 'saved', 'A');
      act(() => channel.onmessage?.({ data }));
      expect(screen.getByRole('alert')).toHaveTextContent(/malformed or too large/);
      expect(await readDownload('TXT')).toBe('saved\n');
    }
  );

  it('deduplicates event IDs without treating them as item identity', async () => {
    render(<SttApp />);
    await startLive();
    const event = {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      event_id: 'event-1',
      delta: 'ha'
    };
    emitEvent(event);
    emitEvent(event);
    emitEvent({ ...event, event_id: 'event-2' });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('haha');
    emitTranscript('completed', 'corrected', 'A');
    expect(await readDownload('TXT')).toBe('corrected\n');
  });

  it('deduplicates transcription event IDs independently of registration events', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'A', event_id: 'same' });
    emitEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      event_id: 'same',
      delta: 'saved'
    });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('saved');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'same-event',
      transcript: 'anonymous'
    },
    {
      type: 'conversation.item.input_audio_transcription.failed',
      event_id: 'same-event'
    },
    {
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'same-event',
      item_id: 'B',
      delta: 'saved'
    }
  ])('rejects event ID reuse with missing or conflicting identity %#', async (event) => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      event_id: 'same-event',
      delta: 'saved'
    });
    emitEvent(event);
    emitTranscript('completed', 'should not commit', 'A');
    expect(screen.getByRole('alert')).toHaveTextContent(/item ID|event ID.*reused/);
    expect(await readDownload('TXT')).toBe('saved\n');
  });

  it('does not block audio on a created non-audio predecessor', async () => {
    render(<SttApp />);
    await startLive();
    act(() =>
      channel.onmessage?.({
        data: JSON.stringify({
          type: 'conversation.item.created',
          previous_item_id: null,
          item: { id: 'A', content: [{ type: 'input_text', text: 'hello' }] }
        })
      })
    );
    act(() =>
      channel.onmessage?.({
        data: JSON.stringify({
          type: 'input_audio_buffer.committed',
          item_id: 'B',
          previous_item_id: 'A'
        })
      })
    );
    emitTranscript('completed', 'speech', 'B');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('speech');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await readDownload('TXT')).toBe('speech\n');
  });

  it.each(['clear', 'edit', 'replace'] as const)(
    'preserves %s across overlapping drafts and out-of-order completions',
    async (action) => {
      render(<SttApp />);
      await startLive();
      emitTranscript('delta', 'first draft', 'A');
      emitTranscript('delta', 'second draft', 'B');
      emitTranscript('completed', 'second final', 'B');
      expect(screen.getByLabelText('Transcript text')).toHaveValue('first draft second final');
      if (action === 'clear') fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      if (action === 'edit')
        fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'Edited' } });
      if (action === 'replace') await uploadTranscript();
      emitTranscript('completed', 'first final', 'A');
      emitTranscript('completed', 'second final', 'B');
      emitTranscript('completed', 'new', 'C');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        action === 'clear' ? '' : action === 'edit' ? 'Edited' : 'Original transcript.'
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/workspace changed/);
      if (action === 'replace') fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await startLive();
      emitTranscript('completed', 'new', 'C');
      expect(await readDownload('TXT')).toBe(
        (action === 'clear'
          ? 'new'
          : action === 'edit'
            ? 'Edited new'
            : 'Original transcript. new') + '\n'
      );
    }
  );

  it('stops with overlapping drafts in order and ignores later completions', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('delta', 'first draft', 'A');
    emitTranscript('delta', 'second draft', 'B');
    emitTranscript('completed', 'second final', 'B');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    emitTranscript('completed', 'first final', 'A');
    expect(await readDownload('TXT')).toBe('first draft second final\n');
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it.each(['clear', 'edit', 'replace'] as const)(
    'ignores an item registered before its first delta after %s',
    async (action) => {
      render(<SttApp />);
      await startLive();
      act(() =>
        channel.onmessage?.({
          data: JSON.stringify({
            type: 'input_audio_buffer.speech_started',
            item_id: 'A'
          })
        })
      );
      if (action === 'clear') fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      if (action === 'edit')
        fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: 'Edited' } });
      if (action === 'replace') await uploadTranscript();
      emitTranscript('completed', 'new', 'B');
      emitTranscript('completed', 'old', 'A');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        action === 'clear' ? '' : action === 'edit' ? 'Edited' : 'Original transcript.'
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/workspace changed/);
      if (action === 'replace') fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await startLive();
      emitTranscript('completed', 'new', 'B');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        action === 'clear' ? 'new' : action === 'edit' ? 'Edited new' : 'Original transcript. new'
      );
    }
  );
});

describe('cancelled connection startup', () => {
  it('releases the connection on Stop while the answer is pending and ignores its resolution', async () => {
    let resolveAnswer!: (answer: Response) => void;
    const answer = new Promise<Response>((resolve) => {
      resolveAnswer = resolve;
    });
    vi.mocked(fetch).mockReturnValueOnce(answer);
    const close = vi.fn();
    const setRemoteDescription = vi.fn();
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        createDataChannel = () => channel;
        addTrack = vi.fn();
        createOffer = async () => ({ type: 'offer', sdp: 'offer' });
        setLocalDescription = vi.fn();
        setRemoteDescription = setRemoteDescription;
        close = close;
      }
    );
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(async () => {
      resolveAnswer(new Response('synthetic answer'));
      await answer;
    });
    expect(close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(setRemoteDescription).not.toHaveBeenCalled();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('does not connect after an outstanding offer resolves', async () => {
    let resolveOffer!: (offer: RTCSessionDescriptionInit) => void;
    const offer = new Promise<RTCSessionDescriptionInit>((resolve) => {
      resolveOffer = resolve;
    });
    const close = vi.fn();
    const setLocalDescription = vi.fn();
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        createDataChannel = () => channel;
        addTrack = vi.fn();
        createOffer = () => offer;
        setLocalDescription = setLocalDescription;
        close = close;
      }
    );
    render(<SttApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.getByText('Connecting')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(async () => {
      resolveOffer({ type: 'offer', sdp: 'offer' });
      await offer;
    });
    expect(close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(setLocalDescription).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
