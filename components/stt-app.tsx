'use client';

import {
  AlertTriangle,
  Clipboard,
  Download,
  Eraser,
  FileAudio,
  Loader2,
  Mic,
  PauseCircle,
  Radio,
  RotateCcw,
  Upload
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  acceptedExtensions,
  acceptedMimeTypes,
  appLimits,
  type FileSttModel,
  isFileSttModel,
  languageOptions,
  sttModels
} from '@/src/lib/constants';
import {
  exportJson,
  exportSrt,
  exportTxt,
  exportVtt,
  hasTimestamps,
  type TranscriptDocument
} from '@/src/lib/transcriptExport';

type Mode = 'live' | 'upload';
type UploadState = 'idle' | 'validating' | 'uploading' | 'done' | 'error';
type LiveState = 'idle' | 'connecting' | 'live' | 'fallback-recording' | 'stopped' | 'error';

type ApiError = {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
};

const emptyTranscript: TranscriptDocument = {
  text: '',
  language: 'en',
  createdAt: undefined,
  segments: []
};

const acceptedAttribute = [...acceptedMimeTypes, ...acceptedExtensions].join(',');

const readApiError = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as ApiError;
  return body.error?.message || `Request failed with HTTP ${response.status}.`;
};

const download = (name: string, contents: string, type: string) => {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

const extractRealtimeText = (event: Record<string, unknown>) => {
  const type = String(event.type || '');
  if (!type.includes('transcription') && !type.includes('transcript')) return null;

  const delta = event.delta || event.transcript_delta;
  if (typeof delta === 'string') return { kind: 'partial' as const, text: delta };

  const text = event.transcript || event.text || event.final_transcript;
  if (typeof text === 'string') {
    return {
      kind: type.includes('delta') ? ('partial' as const) : ('final' as const),
      text
    };
  }

  const item = event.item as
    | { content?: Array<{ transcript?: string; text?: string }> }
    | undefined;
  const contentText =
    item?.content?.map((part) => part.transcript || part.text || '').join('') || '';
  if (contentText) return { kind: 'final' as const, text: contentText };

  return null;
};

export function SttApp() {
  const [mode, setMode] = useState<Mode>('live');
  const [language, setLanguage] = useState('en');
  const [fileModel, setFileModel] = useState<FileSttModel>(sttModels.fileDefault);
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadError, setUploadError] = useState('');
  const [liveState, setLiveState] = useState<LiveState>('idle');
  const [liveError, setLiveError] = useState('');
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState<TranscriptDocument>(emptyTranscript);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fallbackChunksRef = useRef<Blob[]>([]);

  const transcriptText = transcript.text;
  const canExportTimed = hasTimestamps(transcript);

  const fileHelp = useMemo(
    () =>
      `Max ${Math.floor(appLimits.maxUploadBytes / 1024 / 1024)} MB. Audio and video files accepted.`,
    []
  );

  const applyFinalText = useCallback(
    (text: string) => {
      setTranscript((current) => ({
        ...current,
        text: `${current.text}${current.text && !current.text.endsWith(' ') ? ' ' : ''}${text}`.trimStart(),
        language,
        model: sttModels.realtime,
        createdAt: current.createdAt || new Date().toISOString()
      }));
      setPartial('');
    },
    [language]
  );

  const stopMedia = useCallback(() => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const transcribeFallbackRecording = useCallback(
    async (blob: Blob) => {
      const fallbackFile = new File([blob], `live-recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm'
      });
      const body = new FormData();
      body.set('file', fallbackFile);
      body.set('language', language);
      body.set('model', fileModel);

      const response = await fetch('/api/transcribe', { method: 'POST', body });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { transcript: TranscriptDocument };
      setTranscript(data.transcript);
    },
    [fileModel, language]
  );

  const startFallbackRecorder = useCallback(
    (stream: MediaStream, reason: string) => {
      fallbackChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) fallbackChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        try {
          setLiveState('connecting');
          const blob = new Blob(fallbackChunksRef.current, { type: 'audio/webm' });
          await transcribeFallbackRecording(blob);
          setLiveState('stopped');
        } catch (error) {
          setLiveError(error instanceof Error ? error.message : 'Fallback transcription failed.');
          setLiveState('error');
        } finally {
          stopMedia();
        }
      };
      recorderRef.current = recorder;
      recorder.start(1_000);
      setLiveError(`${reason} Recording locally in this tab and transcribing after Stop.`);
      setLiveState('fallback-recording');
    },
    [stopMedia, transcribeFallbackRecording]
  );

  const startLive = useCallback(async () => {
    setLiveError('');
    setPartial('');
    setLiveState('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionResponse = await fetch('/api/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, delay: 'low' })
      });

      if (!sessionResponse.ok) {
        throw new Error(await readApiError(sessionResponse));
      }

      const session = (await sessionResponse.json()) as { clientSecret: string; model: string };
      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setLiveState('live');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setLiveError('Realtime connection was interrupted. Stop and retry.');
          setLiveState('error');
        }
      };

      const channel = pc.createDataChannel('oai-events');
      channel.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data as string) as Record<string, unknown>;
          const update = extractRealtimeText(parsed);
          if (!update) return;
          if (update.kind === 'partial') setPartial(update.text);
          else applyFinalText(update.text);
        } catch {
          // Realtime data channel can include events not needed by this UI.
        }
      };

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const answer = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp || ''
      });

      if (!answer.ok) {
        throw new Error('Realtime WebRTC connection failed.');
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
      setTranscript((current) => ({
        ...current,
        language,
        model: session.model,
        createdAt: current.createdAt || new Date().toISOString()
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Realtime transcription is unavailable.';
      if (streamRef.current && typeof MediaRecorder !== 'undefined') {
        startFallbackRecorder(streamRef.current, message);
        return;
      }
      setLiveError(
        `${message} Use File Upload or check microphone permissions and server configuration.`
      );
      setLiveState('error');
      stopMedia();
    }
  }, [applyFinalText, language, startFallbackRecorder, stopMedia]);

  const stopLive = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
      recorderRef.current = null;
      return;
    }

    stopMedia();
    setPartial('');
    setLiveState('stopped');
  }, [stopMedia]);

  const validateClientFile = (candidate: File) => {
    if (candidate.size > appLimits.maxUploadBytes) {
      throw new Error(
        `File is larger than ${Math.floor(appLimits.maxUploadBytes / 1024 / 1024)} MB.`
      );
    }

    const extensionOk = acceptedExtensions.some((extension) =>
      candidate.name.toLowerCase().endsWith(extension)
    );
    const mimeOk = acceptedMimeTypes.includes(candidate.type as (typeof acceptedMimeTypes)[number]);
    if (!extensionOk && !mimeOk) throw new Error('Choose a supported audio or video file.');
  };

  const uploadFile = async () => {
    if (!file) {
      setUploadError('Choose an audio or video file first.');
      setUploadState('error');
      return;
    }

    try {
      setUploadState('validating');
      setUploadError('');
      validateClientFile(file);

      const body = new FormData();
      body.set('file', file);
      body.set('language', language);
      body.set('model', fileModel);
      if (prompt.trim()) body.set('prompt', prompt.trim());

      setUploadState('uploading');
      const response = await fetch('/api/transcribe', { method: 'POST', body });
      if (!response.ok) throw new Error(await readApiError(response));

      const data = (await response.json()) as { transcript: TranscriptDocument };
      setTranscript(data.transcript);
      setUploadState('done');
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload transcription failed.');
      setUploadState('error');
    }
  };

  const clearWorkspace = () => {
    setTranscript(emptyTranscript);
    setPartial('');
    setUploadError('');
    setLiveError('');
  };

  return (
    <main className="shell">
      <section className="masthead" aria-labelledby="title">
        <div>
          <p className="eyebrow">server-side OpenAI transcription</p>
          <h1 id="title">Signal STT</h1>
        </div>
        <div className="privacy">
          <AlertTriangle size={18} aria-hidden />
          <p>
            Audio is sent to OpenAI for transcription. This app does not store audio or transcripts
            by default.
          </p>
        </div>
      </section>

      <section className="workbench" aria-label="Speech to text controls">
        <div className="control-panel">
          <div className="mode-switch" role="tablist" aria-label="Transcription mode">
            <button
              type="button"
              className={mode === 'live' ? 'active' : ''}
              onClick={() => setMode('live')}
              role="tab"
              aria-selected={mode === 'live'}
            >
              <Mic size={18} aria-hidden />
              Live Mic
            </button>
            <button
              type="button"
              className={mode === 'upload' ? 'active' : ''}
              onClick={() => setMode('upload')}
              role="tab"
              aria-selected={mode === 'upload'}
            >
              <FileAudio size={18} aria-hidden />
              File Upload
            </button>
          </div>

          <label className="field">
            <span>Language hint</span>
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {mode === 'live' ? (
            <div className="mode-body">
              <div className={`state-row ${liveState}`}>
                <Radio size={18} aria-hidden />
                <span>{liveState.replace('-', ' ')}</span>
              </div>
              <div className="button-row">
                <button
                  className="primary"
                  type="button"
                  onClick={startLive}
                  disabled={
                    liveState === 'connecting' ||
                    liveState === 'live' ||
                    liveState === 'fallback-recording'
                  }
                >
                  {liveState === 'connecting' ? (
                    <Loader2 className="spin" size={18} />
                  ) : (
                    <Mic size={18} />
                  )}
                  Start
                </button>
                <button
                  type="button"
                  onClick={stopLive}
                  disabled={!['live', 'fallback-recording', 'connecting'].includes(liveState)}
                >
                  <PauseCircle size={18} aria-hidden />
                  Stop
                </button>
                <button type="button" onClick={startLive} disabled={liveState === 'live'}>
                  <RotateCcw size={18} aria-hidden />
                  Retry
                </button>
              </div>
              {partial ? (
                <div className="partial" aria-live="polite">
                  {partial}
                </div>
              ) : null}
              {liveError ? <p className="error">{liveError}</p> : null}
            </div>
          ) : (
            <div className="mode-body">
              <label className="drop-zone">
                <Upload size={26} aria-hidden />
                <span>{file ? file.name : 'Choose audio or video'}</span>
                <small>{fileHelp}</small>
                <input
                  type="file"
                  accept={acceptedAttribute}
                  onChange={(event) => setFile(event.target.files?.[0] || null)}
                />
              </label>

              <label className="field">
                <span>File model</span>
                <select
                  value={fileModel}
                  onChange={(event) => {
                    if (isFileSttModel(event.target.value)) setFileModel(event.target.value);
                  }}
                >
                  <option value={sttModels.fileDefault}>
                    Fast default: {sttModels.fileDefault}
                  </option>
                  <option value={sttModels.fileHighAccuracy}>
                    Higher accuracy: {sttModels.fileHighAccuracy}
                  </option>
                </select>
              </label>

              <label className="field">
                <span>Vocabulary/context hint</span>
                <textarea
                  value={prompt}
                  maxLength={500}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Names, acronyms, spelling preferences..."
                />
              </label>

              <button
                className="primary wide"
                type="button"
                onClick={uploadFile}
                disabled={uploadState === 'uploading'}
              >
                {uploadState === 'uploading' ? (
                  <Loader2 className="spin" size={18} />
                ) : (
                  <Upload size={18} />
                )}
                {uploadState === 'uploading' ? 'Transcribing' : 'Transcribe file'}
              </button>
              <div className={`state-row ${uploadState}`}>
                <span>{uploadState}</span>
              </div>
              {uploadError ? <p className="error">{uploadError}</p> : null}
            </div>
          )}
        </div>

        <div className="transcript-panel">
          <div className="workspace-head">
            <div>
              <p className="eyebrow">editable transcript</p>
              <h2>Workspace</h2>
            </div>
            <div className="icon-row">
              <button
                type="button"
                title="Copy transcript"
                aria-label="Copy transcript"
                onClick={() => navigator.clipboard.writeText(transcriptText)}
                disabled={!transcriptText}
              >
                <Clipboard size={18} aria-hidden />
              </button>
              <button type="button" title="Clear" aria-label="Clear" onClick={clearWorkspace}>
                <Eraser size={18} aria-hidden />
              </button>
            </div>
          </div>

          <textarea
            className="transcript"
            aria-label="Transcript text"
            value={transcriptText}
            placeholder="Transcript text appears here. You can edit it before copying or exporting."
            onChange={(event) =>
              setTranscript((current) => ({
                ...current,
                text: event.target.value
              }))
            }
          />

          <div className="export-row" aria-label="Export transcript">
            <button
              type="button"
              onClick={() => download('transcript.txt', exportTxt(transcript), 'text/plain')}
              disabled={!transcriptText}
            >
              <Download size={17} aria-hidden />
              TXT
            </button>
            <button
              type="button"
              onClick={() =>
                download('transcript.json', exportJson(transcript), 'application/json')
              }
              disabled={!transcriptText}
            >
              <Download size={17} aria-hidden />
              JSON
            </button>
            <button
              type="button"
              onClick={() =>
                download('transcript.srt', exportSrt(transcript.segments), 'application/x-subrip')
              }
              disabled={!canExportTimed}
            >
              <Download size={17} aria-hidden />
              SRT
            </button>
            <button
              type="button"
              onClick={() => download('transcript.vtt', exportVtt(transcript.segments), 'text/vtt')}
              disabled={!canExportTimed}
            >
              <Download size={17} aria-hidden />
              VTT
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
