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
let channel: {
  onmessage: ((message: { data: string }) => void) | null;
  readyState: string;
  send: ReturnType<typeof vi.fn>;
};
let stopTrack: ReturnType<typeof vi.fn>;
let automaticItemId: number;
let automaticEventId: number;

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

async function uploadTranscript(document: TranscriptDocument = uploadedTranscript) {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ transcript: document }), {
      headers: { 'Content-Type': 'application/json' }
    })
  );
  fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
  fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
    target: { files: [new File(['synthetic audio'], 'sample.mp3', { type: 'audio/mpeg' })] }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
  await screen.findByText('done');
  await waitFor(() => expect(screen.getByLabelText('Transcript text')).toHaveValue(document.text));
}

async function startLive(model: string | null = 'gpt-realtime-whisper') {
  automaticItemId = 0;
  automaticEventId = 0;
  const headers = new Headers();
  if (model !== null) headers.set('X-STT-Model', model);
  vi.mocked(fetch).mockResolvedValueOnce(new Response('synthetic answer', { headers }));
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
  const previous = automaticItemId === 0 ? null : `automatic-item-${automaticItemId - 1}`;
  if (itemId === undefined && type === 'completed') automaticItemId++;
  act(() => {
    channel.onmessage?.({
      data: JSON.stringify({
        type: `conversation.item.input_audio_transcription.${type}`,
        event_id: `automatic-event-${++automaticEventId}`,
        item_id: id,
        ...(itemId === undefined ? { previous_item_id: previous } : {}),
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
  channel = { onmessage: null, readyState: 'open', send: vi.fn() };
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
  const testNavigator = Object.assign(Object.create(navigator), {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getAudioTracks: () => [track],
        getTracks: () => [track]
      })
    }
  });
  Object.defineProperty(testNavigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
  vi.stubGlobal('navigator', testNavigator);
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
      language: undefined,
      model: 'edited',
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

  it('preserves upload provenance until speech and marks mixed sources afterwards', async () => {
    render(<SttApp />);
    await uploadTranscript();
    fireEvent.change(screen.getByLabelText('Language hint'), { target: { value: 'es' } });
    await startLive();
    expect(JSON.parse(await readDownload('JSON'))).toEqual(uploadedTranscript);
    emitTranscript('delta', 'Nuevo');
    const mixed = JSON.parse(await readDownload('JSON'));
    expect(mixed).toMatchObject({
      text: 'Original transcript. Nuevo',
      model: 'mixed',
      segments: []
    });
    expect(mixed.language).toBeUndefined();
  });

  it.each([
    ['auto', 'auto', undefined],
    ['en', 'auto', undefined],
    ['auto', 'en', undefined],
    ['en', 'en', 'en'],
    ['en', 'es', undefined]
  ] as const)(
    'combines upload language %s and live language %s honestly',
    async (uploadedLanguage, sessionLanguage, expected) => {
      render(<SttApp />);
      const uploaded = { ...uploadedTranscript, language: uploadedLanguage };
      await uploadTranscript(uploaded);
      fireEvent.change(screen.getByLabelText('Language hint'), {
        target: { value: sessionLanguage }
      });
      await startLive();
      expect(JSON.parse(await readDownload('JSON'))).toEqual(uploaded);
      emitTranscript('completed', 'Live speech');
      const json = JSON.parse(await readDownload('JSON'));
      expect(json.text).toBe('Original transcript. Live speech');
      expect(json.language).toBe(expected);
    }
  );

  it.each([
    ['default', 'gpt-realtime-whisper', 'gpt-realtime-whisper'],
    ['override', 'synthetic-override-v2', 'synthetic-override-v2'],
    ['missing', null, undefined],
    ['invalid whitespace', 'invalid model', undefined],
    ['overlong', 'x'.repeat(257), undefined]
  ] as const)(
    'uses %s realtime metadata without inventing a model',
    async (_label, model, expected) => {
      render(<SttApp />);
      await startLive(model);
      emitTranscript('delta', ' draft');
      expect(JSON.parse(await readDownload('JSON')).model).toBe(expected);
      emitTranscript('completed', ' final');
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      const json = JSON.parse(await readDownload('JSON'));
      expect(json.model).toBe(expected);
      expect(json.text).toBe(' final');
    }
  );

  it.each([
    ['synthetic-override-v2', 'synthetic-override-v2', 'synthetic-override-v2'],
    ['gpt-4o-mini-transcribe', 'synthetic-override-v2', 'mixed'],
    ['gpt-4o-mini-transcribe', null, undefined]
  ] as const)(
    'combines known or missing model metadata without fabricating provenance',
    async (uploadedModel, realtimeModel, expected) => {
      render(<SttApp />);
      const uploaded = { ...uploadedTranscript, model: uploadedModel };
      await uploadTranscript(uploaded);
      await startLive(realtimeModel);
      expect(JSON.parse(await readDownload('JSON'))).toEqual(uploaded);
      emitTranscript('completed', 'Live speech');
      expect(JSON.parse(await readDownload('JSON')).model).toBe(expected);
    }
  );

  it('keeps realtime provenance session-local across stale callbacks', async () => {
    render(<SttApp />);
    await startLive('synthetic-first');
    const oldHandler = channel.onmessage;
    emitTranscript('completed', 'First');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await startLive('synthetic-second');
    act(() =>
      oldHandler?.({
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: 'old-final',
          item_id: 'old',
          previous_item_id: null,
          transcript: 'stale'
        })
      })
    );
    emitTranscript('completed', 'Second');
    const json = JSON.parse(await readDownload('JSON'));
    expect(json.text).toBe('First Second');
    expect(json.model).toBe('mixed');
  });

  it('preserves edited indentation through draft, final, Stop, TXT, and JSON', async () => {
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: '  Indented\n  note\n' }
    });
    await startLive();
    emitTranscript('delta', 'draft');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('  Indented\n  note\ndraft');
    emitTranscript('completed', 'speech');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await readDownload('TXT')).toBe('  Indented\n  note\nspeech\n');
    expect(JSON.parse(await readDownload('JSON')).text).toBe('  Indented\n  note\nspeech');
  });

  it('appends fallback speech to an upload without retaining its alignment', async () => {
    stubMediaRecorder();
    render(<SttApp />);
    await uploadTranscript();
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcript: {
              text: 'Fallback speech',
              model: 'gpt-4o-mini-transcribe',
              language: 'en',
              segments: []
            }
          })
        )
      );
    fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Recording locally');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        'Original transcript. Fallback speech'
      )
    );
    expect(await readDownload('TXT')).toBe('Original transcript. Fallback speech\n');
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: 'Original transcript. Fallback speech',
      segments: []
    });
    expect(getExportButton('SRT')).toBeDisabled();
    expect(getExportButton('VTT')).toBeDisabled();
  });

  it.each([
    ['auto', 'auto', undefined],
    ['en', 'auto', undefined],
    ['auto', 'en', undefined],
    ['en', 'en', 'en']
  ] as const)(
    'combines upload language %s and fallback language %s honestly',
    async (uploadedLanguage, fallbackLanguage, expected) => {
      stubMediaRecorder();
      render(<SttApp />);
      await uploadTranscript({ ...uploadedTranscript, language: uploadedLanguage });
      fireEvent.change(screen.getByLabelText('Language hint'), {
        target: { value: fallbackLanguage }
      });
      vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              transcript: {
                text: 'Fallback speech',
                model: 'synthetic-file-model',
                language: fallbackLanguage,
                segments: []
              }
            })
          )
        );
      fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await screen.findByText('Recording locally');
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() =>
        expect(screen.getByLabelText('Transcript text')).toHaveValue(
          'Original transcript. Fallback speech'
        )
      );
      const json = JSON.parse(await readDownload('JSON'));
      expect(json.language).toBe(expected);
      expect(json.model).toBe('mixed');
    }
  );

  it('uses fallback file provenance when no realtime speech exists', async () => {
    stubMediaRecorder();
    render(<SttApp />);
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcript: {
              text: 'Fallback speech',
              model: 'synthetic-file-model',
              language: 'en',
              segments: []
            }
          })
        )
      );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Recording locally');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Transcript text')).toHaveValue('Fallback speech')
    );
    expect(JSON.parse(await readDownload('JSON')).model).toBe('synthetic-file-model');
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
          event_id: 'queued-draft',
          item_id: 'queued-item',
          previous_item_id: null,
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
  it('reconciles late order and explicitly labels unresolved items on Stop', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    expect(screen.getByText(/order is unconfirmed/i)).toBeInTheDocument();
    expect(getExportButton('TXT')).toBeDisabled();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('first second');
    expect(getExportButton('JSON')).toBeDisabled();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    expect(await readDownload('TXT')).toBe('first second\n');
    expect(JSON.parse(await readDownload('JSON')).text).toBe('first second');

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await startLive();
    emitTranscript('completed', 'fourth', 'D');
    emitTranscript('completed', 'third', 'C');
    expect(getExportButton('TXT')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const text =
      'first second [Live item; order unconfirmed]\nfourth\n\n[Live item; order unconfirmed]\nthird';
    expect(screen.getByLabelText('Transcript text')).toHaveValue(text);
    expect(await readDownload('TXT')).toBe(`${text}\n`);
    expect(JSON.parse(await readDownload('JSON')).text).toBe(text);
  });

  it('blocks edited provisional exports through late metadata and labels on Stop', async () => {
    render(<SttApp />);
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: '  Earlier\n' }
    });
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    const edited = '  Earlier\nsecond first!\n';
    expect(screen.getByLabelText('Transcript text')).toHaveValue('  Earlier\nsecond first');
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: edited } });
    expect(screen.getByText(/This edit may retain live text/)).toBeVisible();
    for (const name of ['Copy transcript', 'TXT', 'JSON', 'SRT', 'VTT']) {
      expect(getExportButton(name)).toBeDisabled();
      fireEvent.click(getExportButton(name));
    }
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);

    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    expect(screen.getByLabelText('Transcript text')).toHaveValue(edited);
    expect(getExportButton('Copy transcript')).toBeDisabled();
    expect(getExportButton('TXT')).toBeDisabled();
    expect(getExportButton('JSON')).toBeDisabled();

    fireEvent.click(getExportButton('Stop'));
    const labeled = `[Edited live text; order unconfirmed]\n${edited}`;
    expect(screen.getByLabelText('Transcript text')).toHaveValue(labeled);
    fireEvent.click(getExportButton('Copy transcript'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(labeled);
    expect(await readDownload('TXT')).toBe(labeled);
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: labeled,
      model: 'edited',
      segments: []
    });
    expect(JSON.parse(await readDownload('JSON')).language).toBeUndefined();
  });

  it('allows ordinary edits after late metadata has established item order', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'first second!' }
    });
    expect(screen.queryByText(/This edit may retain live text/)).not.toBeInTheDocument();
    expect(await readDownload('TXT')).toBe('first second!\n');
    expect(JSON.parse(await readDownload('JSON'))).toMatchObject({
      text: 'first second!',
      model: 'edited',
      segments: []
    });
  });

  it('keeps uncertainty when an edit races metadata resolving the displayed preview', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    act(() => {
      channel.onmessage?.({
        data: JSON.stringify({
          type: 'input_audio_buffer.committed',
          item_id: 'B',
          previous_item_id: 'A'
        })
      });
      channel.onmessage?.({
        data: JSON.stringify({
          type: 'input_audio_buffer.committed',
          item_id: 'A',
          previous_item_id: null
        })
      });
      fireEvent.change(screen.getByLabelText('Transcript text'), {
        target: { value: 'second first!' }
      });
    });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('second first!');
    expect(getExportButton('Copy transcript')).toBeDisabled();
    expect(getExportButton('TXT')).toBeDisabled();
    expect(getExportButton('JSON')).toBeDisabled();
    fireEvent.click(getExportButton('Stop'));
    expect(await readDownload('TXT')).toBe(
      '[Edited live text; order unconfirmed]\nsecond first!\n'
    );
  });

  it.each(['Keep text with order warning', 'Confirm edited order'] as const)(
    'requires the explicit %s choice before exporting an edited provisional preview',
    async (choice) => {
      render(<SttApp />);
      await startLive();
      emitTranscript('completed', 'second', 'B');
      emitTranscript('completed', 'first', 'A');
      fireEvent.change(screen.getByLabelText('Transcript text'), {
        target: { value: 'second first!' }
      });
      expect(getExportButton('TXT')).toBeDisabled();
      fireEvent.click(getExportButton(choice));
      const expected =
        choice === 'Keep text with order warning'
          ? '[Edited live text; order unconfirmed]\nsecond first!'
          : 'second first!';
      expect(await readDownload('TXT')).toBe(`${expected}\n`);
      expect(JSON.parse(await readDownload('JSON')).text).toBe(expected);
      fireEvent.click(getExportButton('Stop'));
      expect(screen.getByLabelText('Transcript text')).toHaveValue(expected);
    }
  );

  it.each(['edited label', 'stopped item labels'] as const)(
    'does not silently export retained provisional text when removing %s',
    async (source) => {
      render(<SttApp />);
      await startLive();
      emitTranscript('completed', 'second', 'B');
      emitTranscript('completed', 'first', 'A');
      if (source === 'edited label') {
        fireEvent.change(screen.getByLabelText('Transcript text'), {
          target: { value: 'second first!' }
        });
        fireEvent.click(getExportButton('Keep text with order warning'));
      } else {
        fireEvent.click(getExportButton('Stop'));
      }
      fireEvent.change(screen.getByLabelText('Transcript text'), {
        target: { value: 'second first!' }
      });
      expect(getExportButton('Copy transcript')).toBeDisabled();
      expect(getExportButton('TXT')).toBeDisabled();
      expect(getExportButton('JSON')).toBeDisabled();
      fireEvent.click(getExportButton('Keep text with order warning'));
      expect(await readDownload('TXT')).toBe(
        '[Edited live text; order unconfirmed]\nsecond first!\n'
      );
    }
  );

  it('fences an edit queued in the same batch as an unresolved Stop', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    act(() => {
      fireEvent.click(getExportButton('Stop'));
      fireEvent.change(screen.getByLabelText('Transcript text'), {
        target: { value: 'second first!' }
      });
    });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('second first!');
    expect(getExportButton('Copy transcript')).toBeDisabled();
    expect(getExportButton('TXT')).toBeDisabled();
    expect(getExportButton('JSON')).toBeDisabled();
    fireEvent.click(getExportButton('Keep text with order warning'));
    expect(await readDownload('TXT')).toBe(
      '[Edited live text; order unconfirmed]\nsecond first!\n'
    );
  });

  it('keeps a retained edited-order warning without duplicating it', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'second first!' }
    });
    fireEvent.click(getExportButton('Keep text with order warning'));
    const edited = '[Edited live text; order unconfirmed]\nsecond first!?';
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: edited } });
    expect(getExportButton('TXT')).toBeDisabled();
    fireEvent.click(getExportButton('Keep text with order warning'));
    expect(await readDownload('TXT')).toBe(`${edited}\n`);
  });

  it('retains uncertainty when an erased edit is restored before an explicit choice', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: '' } });
    expect(getExportButton('Keep text with order warning')).toBeDisabled();
    expect(getExportButton('Confirm edited order')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'second first!' }
    });
    expect(getExportButton('Copy transcript')).toBeDisabled();
    expect(getExportButton('TXT')).toBeDisabled();
    expect(getExportButton('JSON')).toBeDisabled();
    fireEvent.click(getExportButton('Stop'));
    expect(await readDownload('TXT')).toBe(
      '[Edited live text; order unconfirmed]\nsecond first!\n'
    );
  });

  it('retains a warning when Stop follows an erased provisional edit', async () => {
    render(<SttApp />);
    await startLive();
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    fireEvent.change(screen.getByLabelText('Transcript text'), { target: { value: '' } });
    fireEvent.click(getExportButton('Stop'));
    expect(screen.getByLabelText('Transcript text')).toHaveValue(
      '[Edited live text; order unconfirmed]\n'
    );
    fireEvent.change(screen.getByLabelText('Transcript text'), {
      target: { value: 'second first!' }
    });
    expect(getExportButton('TXT')).toBeDisabled();
    expect(getExportButton('JSON')).toBeDisabled();
  });

  it.each(['clear workspace', 'replacement upload'] as const)(
    'discards edited provisional text on %s',
    async (action) => {
      render(<SttApp />);
      await startLive();
      emitTranscript('completed', 'second', 'B');
      emitTranscript('completed', 'first', 'A');
      fireEvent.change(screen.getByLabelText('Transcript text'), {
        target: { value: 'second first!' }
      });
      if (action === 'clear workspace') {
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        fireEvent.change(screen.getByLabelText('Transcript text'), {
          target: { value: 'Entirely new text' }
        });
        expect(await readDownload('TXT')).toBe('Entirely new text\n');
      } else {
        await uploadTranscript();
        expect(JSON.parse(await readDownload('JSON'))).toEqual(uploadedTranscript);
      }
    }
  );
  it.each([
    { description: 'empty', content: [] },
    { description: 'absent', content: undefined },
    { description: 'unknown', content: [{ type: 'unknown' }] },
    { description: 'audio only', content: [{ type: 'input_audio' }] }
  ])('keeps known audio when created content is $description', async ({ content }) => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'A', previous_item_id: null });
    emitTranscript('delta', 'spoken draft', 'A');
    emitEvent({ type: 'conversation.item.created', item: { id: 'A', content } });
    expect(screen.getByLabelText('Transcript text')).toHaveValue('spoken draft');
    emitTranscript('completed', 'spoken final', 'A');
    expect(await readDownload('TXT')).toBe('spoken final\n');
  });

  it.each(['non-audio first', 'pending audio first', 'resolved audio first'] as const)(
    'fences mixed known non-audio and unknown content with %s',
    async (order) => {
      render(<SttApp />);
      await startLive();
      const nonAudio = {
        type: 'conversation.item.created',
        event_id: 'mixed-created',
        previous_item_id: null,
        item: { id: 'A', content: [{ type: 'input_text', text: 'typed' }, {}] }
      };
      if (order !== 'non-audio first') {
        emitEvent({
          type: 'input_audio_buffer.committed',
          event_id: 'audio-registration',
          item_id: 'A',
          previous_item_id: null
        });
        emitTranscript(order === 'pending audio first' ? 'delta' : 'completed', 'spoken', 'A');
      }
      emitEvent(nonAudio);
      if (order === 'non-audio first') emitTranscript('completed', 'not accepted', 'A');
      expect(screen.getByText(/Live transcription paused:/)).toHaveTextContent(
        /non-audio|audio|conflicting/
      );
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        order === 'non-audio first' ? '' : 'spoken'
      );
      emitTranscript('completed', 'not accepted', 'A');
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        order === 'non-audio first' ? '' : 'spoken'
      );
    }
  );

  it('fences non-audio identity after audio, including after completion', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitTranscript('completed', 'accepted audio', 'A');
    emitEvent({
      type: 'conversation.item.created',
      item: { id: 'A', content: [{ type: 'input_text' }] }
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/non-audio.*conflicts/);
    emitTranscript('completed', 'untrusted', 'B');
    expect(await readDownload('TXT')).toBe('accepted audio\n');
  });

  it('fences a single item claiming both audio and non-audio content', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: null,
      item: { id: 'A', content: [{ type: 'input_audio' }, { type: 'input_text' }] }
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/conflicting audio and non-audio/);
    emitTranscript('completed', 'not accepted', 'A');
    expect(screen.getByLabelText('Transcript text')).toHaveValue('');
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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitTranscript('completed', 'first', 'A');
    expect(await readDownload('TXT')).toBe('first second\n');
  });

  it('reconciles a matching created reference with late predecessor metadata', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'final-B',
      item_id: 'B',
      content_index: 0,
      transcript: 'second'
    });
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'final-A',
      item_id: 'A',
      content_index: 0,
      transcript: 'first'
    });
    const created = {
      type: 'conversation.item.created',
      event_id: 'created-B',
      previous_item_id: 'A',
      item: {
        id: 'B',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'second' }]
      }
    };
    emitEvent(created);
    emitEvent(created);
    expect(screen.getByLabelText('Transcript text')).toHaveValue('first second');
    expect(getExportButton('TXT')).toBeDisabled();
    emitEvent({
      type: 'conversation.item.created',
      event_id: 'created-A',
      previous_item_id: null,
      item: { id: 'A', type: 'message', role: 'user', content: [{ type: 'input_audio' }] }
    });
    expect(screen.queryByText(/Live transcription paused/)).not.toBeInTheDocument();
    expect(await readDownload('TXT')).toBe('first second\n');
    expect(JSON.parse(await readDownload('JSON')).text).toBe('first second');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await readDownload('TXT')).toBe('first second\n');
  });

  it('waits for a matching final when a reference arrives first', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitTranscript('completed', 'first', 'A');
    const created = {
      type: 'conversation.item.created',
      event_id: 'reference-B',
      previous_item_id: 'A',
      item: {
        id: 'B',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'second' }]
      }
    };
    emitEvent(created);
    emitEvent(created);
    expect(screen.getByLabelText('Transcript text')).toHaveValue('first');
    expect(screen.getByText(/reference transcript is unconfirmed/)).toBeVisible();
    expect(getExportButton('TXT')).toBeDisabled();
    expect(getExportButton('JSON')).toBeDisabled();
    emitEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'partial-B',
      item_id: 'B',
      content_index: 0,
      delta: 'sec'
    });
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'final-B',
      item_id: 'B',
      content_index: 0,
      transcript: 'second'
    });
    expect(screen.queryByText(/reference transcript is unconfirmed/)).not.toBeInTheDocument();
    expect(await readDownload('TXT')).toBe('first second\n');
    expect(JSON.parse(await readDownload('JSON')).text).toBe('first second');
  });

  it.each(['reference first', 'final first'] as const)(
    'fences a conflicting reference with %s and retains accepted speech',
    async (order) => {
      render(<SttApp />);
      await startLive();
      const created = {
        type: 'conversation.item.created',
        event_id: 'reference',
        previous_item_id: null,
        item: {
          id: 'A',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_audio', transcript: 'unconfirmed reference' }]
        }
      };
      if (order === 'reference first') {
        emitEvent(created);
        emitTranscript('delta', 'accepted draft', 'A');
        emitTranscript('completed', 'conflicting final', 'A');
      } else {
        emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
        emitTranscript('completed', 'accepted final', 'A');
        emitEvent(created);
      }
      expect(screen.getByText(/reference transcript conflicts/)).toBeVisible();
      emitTranscript('completed', 'later speech', 'B');
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      const retained = order === 'reference first' ? 'accepted draft' : 'accepted final';
      expect(await readDownload('TXT')).toBe(`${retained}\n`);
      expect(JSON.parse(await readDownload('JSON')).text).toBe(retained);
      if (order === 'reference first') {
        expect(screen.getByText(/reference transcript was not included/)).toBeVisible();
      }
    }
  );

  it('reports an omitted unconfirmed reference on Stop without exporting it', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitTranscript('completed', 'accepted', 'A');
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: 'A',
      item: {
        id: 'B',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'not confirmed' }]
      }
    });
    expect(getExportButton('TXT')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText(/reference transcript was not included/)).toBeVisible();
    expect(await readDownload('TXT')).toBe('accepted\n');
    expect(JSON.parse(await readDownload('JSON')).text).toBe('accepted');
    await startLive();
    expect(screen.getByText(/reference transcript was not included/)).toBeVisible();
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: null,
      item: {
        id: 'C',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'later' }]
      }
    });
    emitTranscript('completed', 'later', 'C');
    expect(screen.queryByText(/reference transcript is unconfirmed/)).not.toBeInTheDocument();
    expect(screen.getByText(/reference transcript was not included/)).toBeVisible();
    expect(await readDownload('TXT')).toBe('accepted later\n');
  });

  it('requires confirmation for an empty reference without duplicating later speech', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: null,
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: '' }]
      }
    });
    expect(screen.getByText(/reference transcript is unconfirmed/)).toBeVisible();
    emitTranscript('completed', '', 'A');
    expect(screen.queryByText(/reference transcript is unconfirmed/)).not.toBeInTheDocument();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitTranscript('completed', 'next', 'B');
    expect(await readDownload('TXT')).toBe('next\n');
  });

  it('fences conflicting references and retains a prior partial on Stop', async () => {
    render(<SttApp />);
    await startLive();
    const created = {
      type: 'conversation.item.created',
      previous_item_id: null,
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'first reference' }]
      }
    };
    emitEvent({ ...created, event_id: 'first-reference' });
    emitTranscript('delta', 'accepted draft', 'A');
    emitEvent({
      ...created,
      event_id: 'second-reference',
      item: { ...created.item, content: [{ type: 'input_audio', transcript: 'second reference' }] }
    });
    expect(screen.getByText(/conflicting reference transcripts/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText(/reference transcript was not included/)).toBeVisible();
    expect(await readDownload('TXT')).toBe('accepted draft\n');
  });

  it('does not treat a failed transcription as confirmation of its reference', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: null,
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'unconfirmed reference' }]
      }
    });
    emitTranscript('delta', 'accepted draft', 'A');
    emitEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'A' });
    expect(screen.getByText(/could not be confirmed after transcription failed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText(/reference transcript was not included/)).toBeVisible();
    expect(await readDownload('TXT')).toBe('accepted draft\n');
  });

  it('retains the verified reference index after a matching item is committed', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: null,
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'accepted' }]
      }
    });
    emitTranscript('completed', 'accepted', 'A');
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'A',
      content_index: 1,
      transcript: 'accepted'
    });
    expect(screen.getByText(/conflicting content index/)).toBeVisible();
    expect(await readDownload('TXT')).toBe('accepted\n');
  });

  it.each(['reference first', 'final first'] as const)(
    'rejects a reference for a different content index with %s',
    async (order) => {
      render(<SttApp />);
      await startLive();
      const created = {
        type: 'conversation.item.created',
        previous_item_id: null,
        item: {
          id: 'A',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_audio', transcript: 'same' }]
        }
      };
      const final = {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'A',
        previous_item_id: null,
        content_index: 1,
        transcript: 'same'
      };
      emitEvent(order === 'reference first' ? created : final);
      emitEvent(order === 'reference first' ? final : created);
      expect(screen.getByText(/conflicting content index/)).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(screen.getByLabelText('Transcript text')).toHaveValue(
        order === 'reference first' ? '' : 'same'
      );
    }
  );

  it('bounds unidentified reference text and ignores a stale channel', async () => {
    render(<SttApp />);
    await startLive();
    const oldHandler = channel.onmessage;
    emitEvent({
      type: 'conversation.item.created',
      previous_item_id: null,
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'x'.repeat(1_000_001) }]
      }
    });
    expect(screen.getByText(/pending text limit/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await startLive();
    act(() =>
      oldHandler?.({
        data: JSON.stringify({
          type: 'conversation.item.created',
          previous_item_id: null,
          item: {
            id: 'stale',
            type: 'message',
            role: 'user',
            content: [{ type: 'input_audio', transcript: 'stale' }]
          }
        })
      })
    );
    expect(screen.queryByText(/reference transcript is unconfirmed/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Transcript text')).toHaveValue('');
  });

  it.each(['identified', 'unidentified'] as const)(
    'reports %s server errors without inventing a turn failure',
    async (identity) => {
      render(<SttApp />);
      await startLive();
      const generalError = {
        type: 'error',
        ...(identity === 'identified' ? { event_id: 'general-error' } : {}),
        error: { message: 'private-message', type: 'private-type', code: 'private-code' }
      };
      emitEvent(generalError);
      expect(screen.getByText(/A realtime error was reported/)).toBeVisible();
      expect(screen.queryByText(/audio turn was not accepted/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
      expect(document.body).not.toHaveTextContent(/private-message|private-type|private-code/);
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(stopTrack).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves turn correlation and deduplicates errors after acknowledgement', async () => {
    render(<SttApp />);
    await startLive();
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    const firstCommit = JSON.parse(String(channel.send.mock.calls[0][0]));
    expect(firstCommit.type).toBe('input_audio_buffer.commit');
    const unrelated = {
      type: 'error',
      event_id: 'unrelated-server-error',
      error: { event_id: 'another-client-event', message: 'private-unrelated' }
    };
    emitEvent(unrelated);
    expect(screen.getByText(/pending turn outcome is unknown/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeDisabled();
    emitEvent({
      type: 'input_audio_buffer.committed',
      event_id: 'server-ack',
      item_id: 'A',
      previous_item_id: null
    });
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    expect(screen.queryByText(/pending turn outcome is unknown/)).not.toBeInTheDocument();
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'accepted-transcription',
      item_id: 'A',
      content_index: 0,
      transcript: 'accepted speech'
    });
    emitEvent(unrelated);
    expect(screen.queryByText(/A realtime error was reported/)).not.toBeInTheDocument();
    emitEvent({
      type: 'error',
      event_id: 'after-ack-error',
      error: { message: 'private-after-ack', code: 'private-code', type: 'private-type' }
    });
    expect(screen.getByText(/A realtime error was reported/)).toBeVisible();
    expect(screen.queryByText(/audio turn was not accepted/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish turn' }));
    const secondCommit = JSON.parse(String(channel.send.mock.calls[1][0]));
    expect(secondCommit.event_id).not.toBe(firstCommit.event_id);
    emitEvent({
      type: 'error',
      event_id: 'correlated-server-error',
      error: { event_id: secondCommit.event_id, message: 'private-correlated' }
    });
    expect(screen.getByText(/audio turn was not accepted/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
    expect(document.body).not.toHaveTextContent(
      /private-unrelated|private-after-ack|private-code|private-type|private-correlated/
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(await readDownload('TXT')).toBe('accepted speech\n');
  });

  it('ignores a stale channel error after Stop and restart', async () => {
    render(<SttApp />);
    await startLive();
    const oldHandler = channel.onmessage;
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stopTrack).toHaveBeenCalledTimes(1);
    await startLive();
    act(() =>
      oldHandler?.({
        data: JSON.stringify({
          type: 'error',
          event_id: 'stale-error',
          error: { message: 'private-stale' }
        })
      })
    );
    expect(screen.queryByText(/A realtime error was reported/)).not.toBeInTheDocument();
    expect(screen.getByText('Listening')).toBeVisible();
    expect(document.body).not.toHaveTextContent('private-stale');
  });

  it('keeps known direct predecessors adjacent when other drafts overlap', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'X', previous_item_id: 'B' });
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
    expect(getExportButton('TXT')).toBeDisabled();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    expect(await readDownload('TXT')).toBe('first second\n');
    emitTranscript('completed', 'second', 'B');
    emitTranscript('completed', 'first', 'A');
    expect(await readDownload('TXT')).toBe('first second\n');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('fences first-item metadata that contradicts committed text', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitTranscript('completed', 'later', 'A');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
    emitTranscript('delta', 'first', 'B');
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: null });
    expect(screen.getByRole('alert')).toHaveTextContent(/multiple items.*first/);
    expect(await readDownload('TXT')).toBe('later first\n');
    emitTranscript('completed', 'changed', 'B');
    expect(await readDownload('TXT')).toBe('later first\n');
  });

  it('preserves the displayed order when an oversized update also carries predecessor metadata', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'C', previous_item_id: null });
    emitTranscript('completed', 'accepted', 'C');
    emitEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'C' });
    expect(screen.getByRole('alert')).toHaveTextContent(/terminal item.*conflicting/);
    expect(await readDownload('TXT')).toBe('first second accepted\n');
  });

  it('releases successors after a failed predecessor and visibly reports the failure', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
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
    emitEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'A',
      previous_item_id: null
    });
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
    expect(await readDownload('TXT')).toBe('[Live item; order unconfirmed]\nbuffered second\n');
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
      expect(screen.getByText(/workspace changed.*Stop and Start/)).toBeInTheDocument();
      if (action === 'edit') {
        expect(getExportButton('TXT')).toBeDisabled();
        fireEvent.click(getExportButton('Confirm edited order'));
      }
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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: null });
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
      item: {
        id: 'A',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_audio', transcript: 'unexpected text' }]
      }
    },
    {
      type: 'conversation.item.created',
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: 'unexpected text' }, { type: 'input_audio' }]
      }
    },
    {
      type: 'conversation.item.created',
      item: {
        id: 'A',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript: null }]
      }
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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'saved', previous_item_id: null });
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
      emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
      emitTranscript('delta', 'saved', 'A');
      act(() => channel.onmessage?.({ data }));
      expect(screen.getByRole('alert')).toHaveTextContent(/malformed or too large/);
      expect(await readDownload('TXT')).toBe('saved\n');
    }
  );

  it('deduplicates event IDs without treating them as item identity', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
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

  it('deduplicates distinct registration and transcription events in one identity space', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'input_audio_buffer.speech_started',
      item_id: 'A',
      event_id: 'registration',
      previous_item_id: null
    });
    emitEvent({
      previous_item_id: null,
      event_id: 'registration',
      item_id: 'A',
      type: 'input_audio_buffer.speech_started'
    });
    const delta = {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      event_id: 'transcription',
      delta: 'saved'
    };
    emitEvent(delta);
    emitEvent(delta);
    expect(screen.getByLabelText('Transcript text')).toHaveValue('saved');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['registration-first', 'transcription-first'] as const)(
    'fences cross-kind event ID reuse when %s',
    async (order) => {
      render(<SttApp />);
      await startLive();
      emitEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'A',
        previous_item_id: null,
        event_id: 'seed',
        delta: 'saved'
      });
      const registration = {
        type: 'input_audio_buffer.speech_started',
        item_id: 'A',
        event_id: 'same',
        previous_item_id: null
      };
      const delta = {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'A',
        event_id: 'same',
        delta: ' more'
      };
      emitEvent(order === 'registration-first' ? registration : delta);
      emitEvent(order === 'registration-first' ? delta : registration);
      expect(screen.getByRole('alert')).toHaveTextContent(/event ID.*reused/);
      expect(await readDownload('TXT')).toBe(
        order === 'registration-first' ? 'saved\n' : 'saved more\n'
      );
    }
  );

  it('does not use conflicting registration IDs to resolve provisional final order', async () => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'B',
      event_id: 'final-B',
      transcript: 'second'
    });
    emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'A',
      event_id: 'final-A',
      transcript: 'first'
    });
    emitEvent({
      type: 'input_audio_buffer.committed',
      item_id: 'B',
      event_id: 'final-A',
      previous_item_id: 'A'
    });
    emitEvent({
      type: 'input_audio_buffer.committed',
      item_id: 'A',
      event_id: 'final-B',
      previous_item_id: null
    });
    expect(screen.getByText(/event ID.*reused/)).toBeVisible();
    expect(screen.getByLabelText('Transcript text')).toHaveValue('second first');
    expect(getExportButton('TXT')).toBeDisabled();
    expect(getExportButton('JSON')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await readDownload('TXT')).toBe(
      '[Live item; order unconfirmed]\nsecond\n\n[Live item; order unconfirmed]\nfirst\n'
    );
  });

  it.each([
    { type: 'input_audio_buffer.speech_started', item_id: 'A', previous_item_id: null },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'A', previous_item_id: null },
    { type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null },
    {
      type: 'conversation.item.created',
      item: { id: 'A', content: [{ type: 'input_audio' }] },
      previous_item_id: null
    }
  ])('fences changed registration payloads for $type', async (registration) => {
    render(<SttApp />);
    await startLive();
    emitEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'A',
      event_id: 'draft',
      previous_item_id: null,
      delta: 'saved'
    });
    emitEvent({ ...registration, event_id: 'registration', audio_start_ms: 1 });
    emitEvent({ ...registration, event_id: 'registration', audio_start_ms: 2 });
    expect(screen.getByRole('alert')).toHaveTextContent(/event ID.*reused/);
    expect(await readDownload('TXT')).toBe('saved\n');
  });

  it.each(['', ' ', 42, { invalid: true }])(
    'fences malformed registration event IDs without resolving draft order (%s)',
    async (eventId) => {
      render(<SttApp />);
      await startLive();
      emitEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'A',
        event_id: 'accepted',
        previous_item_id: null,
        transcript: 'accepted'
      });
      emitEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'B',
        event_id: 'draft',
        delta: 'draft'
      });
      emitEvent({
        type: 'input_audio_buffer.committed',
        item_id: 'B',
        event_id: eventId,
        previous_item_id: 'A'
      });
      expect(screen.getByText(/event ID was malformed/)).toBeVisible();
      expect(screen.getByLabelText('Transcript text')).toHaveValue('accepted draft');
      expect(getExportButton('TXT')).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(await readDownload('TXT')).toBe('accepted [Live item; order unconfirmed]\ndraft\n');
    }
  );

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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
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
      expect(screen.getByText(/workspace changed/)).toBeInTheDocument();
      if (action === 'edit') {
        expect(getExportButton('TXT')).toBeDisabled();
        fireEvent.click(getExportButton('Confirm edited order'));
      }
      if (action === 'replace') fireEvent.click(screen.getByRole('tab', { name: 'Live Mic' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await startLive();
      emitEvent({ type: 'input_audio_buffer.committed', item_id: 'C', previous_item_id: null });
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
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'A', previous_item_id: null });
    emitEvent({ type: 'input_audio_buffer.committed', item_id: 'B', previous_item_id: 'A' });
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
