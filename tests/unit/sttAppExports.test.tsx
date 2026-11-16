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

function emitTranscript(type: 'delta' | 'completed', text: string, itemId?: string) {
  act(() => {
    channel.onmessage?.({
      data: JSON.stringify({
        type: `conversation.item.input_audio_transcription.${type}`,
        ...(itemId ? { item_id: itemId } : {}),
        ...(type === 'delta' ? { delta: text } : { transcript: text })
      })
    });
  });
}

beforeEach(() => {
  downloads = [];
  channel = { onmessage: null };
  stopTrack = vi.fn();
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
    expect(screen.getByLabelText('Transcript text')).toHaveValue('New text');
  });

  it('ignores queued live events after stopping and keeps a just-received draft', async () => {
    render(<SttApp />);
    await startLive();
    act(() => {
      channel.onmessage?.({
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
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
        action === 'clear' ? 'new' : action === 'edit' ? 'Edited new' : 'Original transcript. new'
      );
      if (action === 'replace') fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
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
