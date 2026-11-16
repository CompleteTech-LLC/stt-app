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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { LiveUtterances, joinTranscriptText } from '@/src/lib/liveTranscript';

type Mode = 'live' | 'upload';
type UploadState = 'idle' | 'validating' | 'uploading' | 'done' | 'error';
type LiveState =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'live'
  | 'fallback-recording'
  | 'fallback-transcribing'
  | 'stopped'
  | 'error';

type ApiError = {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    upstreamStatus?: number;
    upstreamCode?: string;
  };
};

class ApiFailure extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly retryable?: boolean,
    public readonly upstreamStatus?: number,
    public readonly upstreamCode?: string
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

const emptyTranscript: TranscriptDocument = {
  text: '',
  language: 'en',
  createdAt: undefined,
  segments: []
};

const acceptedAttribute = [...acceptedMimeTypes, ...acceptedExtensions].join(',');

const liveStatusCopy: Record<LiveState, { label: string; detail: string }> = {
  idle: {
    label: 'Ready',
    detail: 'Press Start to request microphone access and open realtime transcription.'
  },
  'requesting-mic': {
    label: 'Requesting microphone',
    detail: 'Waiting for browser microphone permission.'
  },
  connecting: {
    label: 'Connecting',
    detail: 'Opening the secure realtime transcription session.'
  },
  live: {
    label: 'Listening',
    detail: 'Realtime transcript updates are streaming into the workspace.'
  },
  'fallback-recording': {
    label: 'Recording locally',
    detail: 'Realtime is unavailable. Audio will be transcribed after Stop.'
  },
  'fallback-transcribing': {
    label: 'Transcribing recording',
    detail: 'Uploading the local recording for server-side transcription.'
  },
  stopped: {
    label: 'Stopped',
    detail: 'Start again when you are ready for another capture.'
  },
  error: {
    label: 'Realtime unavailable',
    detail: 'Review the error below, then retry when ready.'
  }
};

const readApiFailure = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as ApiError;
  return new ApiFailure(
    body.error?.message || `Request failed with HTTP ${response.status}.`,
    body.error?.code,
    body.error?.retryable,
    body.error?.upstreamStatus,
    body.error?.upstreamCode
  );
};

const shouldAttemptLocalRecordingFallback = (error: unknown) =>
  !(
    error instanceof ApiFailure &&
    ['MISSING_API_KEY', 'UPSTREAM_ERROR', 'CONFIGURATION_ERROR', 'RATE_LIMITED'].includes(
      error.code || ''
    )
  );

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
  if (
    type === 'conversation.item.input_audio_transcription.delta' &&
    typeof event.delta === 'string' &&
    event.transcript === undefined &&
    event.text === undefined &&
    event.transcript_delta === undefined &&
    event.final_transcript === undefined
  ) {
    return { kind: 'partial' as const, text: event.delta };
  }
  if (
    type === 'conversation.item.input_audio_transcription.completed' &&
    typeof event.transcript === 'string' &&
    event.delta === undefined &&
    event.text === undefined &&
    event.transcript_delta === undefined &&
    event.final_transcript === undefined
  ) {
    return { kind: 'final' as const, text: event.transcript };
  }
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
  const [trackerNotice, setTrackerNotice] = useState('');
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState<TranscriptDocument>(emptyTranscript);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const utterancesRef = useRef(new LiveUtterances(false));
  const liveSessionRef = useRef(0);
  const realtimeRequestRef = useRef<AbortController | null>(null);
  const fallbackRequestRef = useRef<AbortController | null>(null);

  const discardLiveDraft = useCallback(() => {
    fallbackRequestRef.current?.abort();
    setLiveState((current) => (current === 'fallback-transcribing' ? 'stopped' : current));
    const tracker = utterancesRef.current;
    tracker.discard();
    setPartial('');
    if (tracker.error) setTrackerNotice(tracker.error);
  }, []);

  const transcriptText = transcript.text;
  const displayedTranscriptText = joinTranscriptText(transcriptText, partial);
  const exportDocument: TranscriptDocument = {
    ...transcript,
    text: displayedTranscriptText,
    // A live draft has no alignment with any previously uploaded segments.
    segments: partial ? [] : transcript.segments
  };
  const canExportTimed = hasTimestamps(exportDocument);
  const liveStatus = liveStatusCopy[liveState];

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
        segments: [],
        language,
        model: sttModels.realtime,
        createdAt: current.createdAt || new Date().toISOString()
      }));
    },
    [language]
  );

  const stopMedia = useCallback(() => {
    liveSessionRef.current += 1;
    realtimeRequestRef.current?.abort();
    realtimeRequestRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      fallbackRequestRef.current?.abort();
      fallbackRequestRef.current = null;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        // Unmount releases capture without uploading an abandoned recording.
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== 'inactive') recorder.stop();
      }
      stopMedia();
    };
  }, [stopMedia]);

  const transcribeFallbackRecording = useCallback(
    async (blob: Blob, signal: AbortSignal) => {
      const fallbackFile = new File([blob], `live-recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm'
      });
      const body = new FormData();
      body.set('file', fallbackFile);
      body.set('language', language);
      body.set('model', fileModel);

      const response = await fetch('/api/transcribe', { method: 'POST', body, signal });
      if (!response.ok) throw await readApiFailure(response);
      const data = (await response.json()) as { transcript: TranscriptDocument };
      return data.transcript;
    },
    [fileModel, language]
  );

  const startFallbackRecorder = useCallback(
    (stream: MediaStream, reason: string) => {
      const request = new AbortController();
      fallbackRequestRef.current = request;
      const chunks: Blob[] = [];
      const fallbackTracker = utterancesRef.current;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      const isCurrent = () => fallbackRequestRef.current === request && !request.signal.aborted;
      recorder.ondataavailable = (event) => {
        if (isCurrent() && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        if (!isCurrent()) return;
        try {
          setLiveState('fallback-transcribing');
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const document = await transcribeFallbackRecording(blob, request.signal);
          if (!isCurrent()) return;
          setTranscript(document);
          if (utterancesRef.current === fallbackTracker) fallbackTracker.finish();
          setPartial('');
          setLiveState('stopped');
        } catch (error) {
          if (!isCurrent()) return;
          if (utterancesRef.current === fallbackTracker) {
            const remaining = fallbackTracker.finish();
            if (remaining.trim()) applyFinalText(remaining);
            setPartial('');
          }
          setLiveError(error instanceof Error ? error.message : 'Fallback transcription failed.');
          setLiveState('error');
        } finally {
          // This callback owns only its request; it must never close a newer session's media.
          if (fallbackRequestRef.current === request) fallbackRequestRef.current = null;
        }
      };
      recorderRef.current = recorder;
      recorder.start(1_000);
      setLiveError(`${reason} Recording locally in this tab and transcribing after Stop.`);
      setLiveState('fallback-recording');
    },
    [applyFinalText, transcribeFallbackRecording]
  );

  const startLive = useCallback(async () => {
    fallbackRequestRef.current?.abort();
    fallbackRequestRef.current = null;
    const oldRecorder = recorderRef.current;
    recorderRef.current = null;
    if (oldRecorder) {
      oldRecorder.ondataavailable = null;
      oldRecorder.onstop = null;
      if (oldRecorder.state !== 'inactive') oldRecorder.stop();
    }
    const remaining = utterancesRef.current.finish();
    if (remaining.trim()) applyFinalText(remaining);
    stopMedia();
    const session = ++liveSessionRef.current;
    setLiveError('');
    utterancesRef.current = new LiveUtterances();
    setTrackerNotice('');
    setPartial('');
    setLiveState('requesting-mic');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== liveSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setLiveState('connecting');

      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      pc.onconnectionstatechange = () => {
        if (session !== liveSessionRef.current) return;
        if (pc.connectionState === 'connected') setLiveState('live');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          const remaining = utterancesRef.current.finish();
          if (remaining.trim()) applyFinalText(remaining);
          setPartial('');
          stopMedia();
          setLiveError('Realtime connection was interrupted. Stop and retry.');
          setLiveState('error');
        }
      };

      const channel = pc.createDataChannel('oai-events');
      channel.onmessage = (message) => {
        if (session !== liveSessionRef.current) return;
        const tracker = utterancesRef.current;
        try {
          if (typeof message.data !== 'string' || message.data.length > 1_100_000) {
            throw new Error('Malformed realtime event');
          }
          const raw: unknown = JSON.parse(message.data);
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Malformed realtime event');
          }
          const parsed = raw as Record<string, unknown>;
          const item =
            parsed.item && typeof parsed.item === 'object'
              ? (parsed.item as Record<string, unknown>)
              : undefined;
          const type = typeof parsed.type === 'string' ? parsed.type : '';
          if (!type) throw new Error('Malformed realtime event');
          const content = Array.isArray(item?.content) ? item.content : [];
          const isCreated = type === 'conversation.item.created';
          const isAudioBufferEvent = [
            'input_audio_buffer.speech_started',
            'input_audio_buffer.speech_stopped',
            'input_audio_buffer.committed'
          ].includes(type);
          const isTranscriptionEvent = type.startsWith(
            'conversation.item.input_audio_transcription.'
          );
          const hasTextFields = [
            'delta',
            'transcript',
            'text',
            'transcript_delta',
            'final_transcript'
          ].some((key) => parsed[key] !== undefined);
          const pendingValues: unknown[] = [parsed];
          let hasUnexpectedTranscript = false;
          while (pendingValues.length && !hasUnexpectedTranscript) {
            const value = pendingValues.pop();
            if (!value || typeof value !== 'object') continue;
            for (const [key, child] of Object.entries(value)) {
              const isExpectedTranscript =
                value === parsed &&
                key === 'transcript' &&
                type === 'conversation.item.input_audio_transcription.completed';
              if (
                ['transcript', 'transcript_delta', 'final_transcript'].includes(key) &&
                child !== undefined &&
                child !== null &&
                child !== '' &&
                !isExpectedTranscript
              ) {
                hasUnexpectedTranscript = true;
                break;
              }
              if (child && typeof child === 'object') pendingValues.push(child);
            }
          }
          const malformedContent =
            isCreated &&
            item?.content !== undefined &&
            item.content !== null &&
            !Array.isArray(item.content);
          const hasUnexpectedContent =
            isCreated &&
            content.some((part: unknown) => {
              if (!part || typeof part !== 'object' || Array.isArray(part)) return true;
              const entry = part as Record<string, unknown>;
              const isText = ['input_text', 'text', 'output_text'].includes(String(entry.type));
              return (
                (entry.delta !== undefined && entry.delta !== null && entry.delta !== '') ||
                (entry.text !== undefined &&
                  entry.text !== null &&
                  (typeof entry.text !== 'string' || (!isText && entry.text !== '')))
              );
            });
          let committed = '';
          if (
            ((isTranscriptionEvent || isAudioBufferEvent) && parsed.item !== undefined) ||
            ((isCreated || isAudioBufferEvent) && hasTextFields) ||
            hasUnexpectedTranscript ||
            malformedContent ||
            hasUnexpectedContent
          ) {
            tracker.reject('a realtime event contained unsupported transcription text.');
          } else if (
            parsed.item_id !== undefined &&
            item?.id !== undefined &&
            parsed.item_id !== item.id
          ) {
            tracker.reject('an event contains conflicting item IDs.');
          } else if (isCreated) {
            const isAudio = content.some(
              (part: unknown) =>
                part &&
                typeof part === 'object' &&
                (part as Record<string, unknown>).type === 'input_audio'
            );
            const isNonAudio =
              content.length > 0 &&
              content.every(
                (part: unknown) =>
                  part &&
                  typeof part === 'object' &&
                  ['input_text', 'text', 'output_text'].includes(
                    String((part as Record<string, unknown>).type)
                  )
              );
            committed = isNonAudio
              ? tracker.skip(item?.id, parsed.previous_item_id)
              : tracker.register(item?.id, parsed.previous_item_id, isAudio);
          } else if (isAudioBufferEvent) {
            committed = tracker.register(parsed.item_id, parsed.previous_item_id, true);
          }
          if (committed) applyFinalText(committed);
          if (type === 'conversation.item.input_audio_transcription.failed') {
            if (
              parsed.delta !== undefined ||
              parsed.transcript !== undefined ||
              parsed.text !== undefined ||
              parsed.transcript_delta !== undefined ||
              parsed.final_transcript !== undefined
            ) {
              tracker.reject('a transcription failure event contained unexpected text.');
            } else {
              committed = tracker.fail(parsed.item_id, parsed.previous_item_id, parsed.event_id);
              if (committed) applyFinalText(committed);
              if (!tracker.error) {
                setTrackerNotice(
                  'A live audio item failed transcription; any partial text may be incomplete.'
                );
              }
            }
          } else {
            const update = extractRealtimeText(parsed);
            if (update) {
              committed = tracker.update(
                parsed.item_id,
                update.kind,
                update.text,
                parsed.event_id,
                parsed.previous_item_id
              );
              if (committed) applyFinalText(committed);
            } else if (
              isTranscriptionEvent ||
              parsed.transcript !== undefined ||
              parsed.transcript_delta !== undefined ||
              parsed.final_transcript !== undefined ||
              ((type.includes('transcription') || type.includes('transcript')) && hasTextFields)
            ) {
              tracker.reject('a transcription event type or text was unsupported or malformed.');
            }
          }
        } catch {
          tracker.reject('a realtime event was malformed or too large.');
        }
        if (tracker.error) setTrackerNotice(tracker.error);
        setPartial(tracker.preview());
      };

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      const offer = await pc.createOffer();
      if (session !== liveSessionRef.current) return;
      await pc.setLocalDescription(offer);
      if (session !== liveSessionRef.current) return;

      const request = new AbortController();
      realtimeRequestRef.current = request;
      const answer = await fetch(
        `/api/realtime/call?language=${encodeURIComponent(language)}&delay=low`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sdp'
          },
          body: offer.sdp || '',
          signal: request.signal
        }
      );

      if (session !== liveSessionRef.current) return;
      if (!answer.ok) {
        throw await readApiFailure(answer);
      }

      const sdp = await answer.text();
      if (session !== liveSessionRef.current) return;
      await pc.setRemoteDescription({ type: 'answer', sdp });
      if (session !== liveSessionRef.current) return;
      setTranscript((current) => ({
        ...current,
        language,
        model: sttModels.realtime,
        createdAt: current.createdAt || new Date().toISOString()
      }));
    } catch (error) {
      if (session !== liveSessionRef.current) return;
      const message =
        error instanceof Error ? error.message : 'Realtime transcription is unavailable.';
      if (
        streamRef.current &&
        typeof MediaRecorder !== 'undefined' &&
        shouldAttemptLocalRecordingFallback(error)
      ) {
        startFallbackRecorder(streamRef.current, message);
        return;
      }
      setLiveError(
        `${message} Check OpenAI billing/model access and restart the app after updating server-side secrets.`
      );
      setLiveState('error');
      const remaining = utterancesRef.current.finish();
      if (remaining.trim()) applyFinalText(remaining);
      setPartial('');
      stopMedia();
    }
  }, [applyFinalText, language, startFallbackRecorder, stopMedia]);

  const stopLive = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      stopMedia();
      setLiveState(
        fallbackRequestRef.current?.signal.aborted ? 'stopped' : 'fallback-transcribing'
      );
      recorder.stop();
      return;
    }

    const remaining = utterancesRef.current.finish();
    if (remaining.trim()) applyFinalText(remaining);
    stopMedia();
    setPartial('');
    setLiveState('stopped');
  }, [applyFinalText, stopMedia]);

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
      if (!response.ok) throw await readApiFailure(response);

      const data = (await response.json()) as { transcript: TranscriptDocument };
      setTranscript(data.transcript);
      discardLiveDraft();
      setUploadState('done');
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload transcription failed.');
      setUploadState('error');
    }
  };

  const clearWorkspace = () => {
    setTranscript(emptyTranscript);
    discardLiveDraft();
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
                {['requesting-mic', 'connecting', 'fallback-transcribing'].includes(liveState) ? (
                  <Loader2 className="spin" size={18} aria-hidden />
                ) : (
                  <Radio size={18} aria-hidden />
                )}
                <span>{liveStatus.label}</span>
              </div>
              <p className="state-detail" aria-live="polite">
                {liveStatus.detail}
              </p>
              <div className="button-row">
                <button
                  className="primary"
                  type="button"
                  onClick={startLive}
                  disabled={
                    liveState === 'requesting-mic' ||
                    liveState === 'connecting' ||
                    liveState === 'live' ||
                    liveState === 'fallback-recording' ||
                    liveState === 'fallback-transcribing'
                  }
                >
                  {['requesting-mic', 'connecting'].includes(liveState) ? (
                    <Loader2 className="spin" size={18} />
                  ) : (
                    <Mic size={18} />
                  )}
                  {['requesting-mic', 'connecting'].includes(liveState) ? 'Starting' : 'Start'}
                </button>
                <button
                  type="button"
                  onClick={stopLive}
                  disabled={
                    !['live', 'fallback-recording', 'requesting-mic', 'connecting'].includes(
                      liveState
                    )
                  }
                >
                  <PauseCircle size={18} aria-hidden />
                  Stop
                </button>
                <button
                  type="button"
                  onClick={startLive}
                  disabled={
                    liveState === 'live' ||
                    liveState === 'requesting-mic' ||
                    liveState === 'connecting' ||
                    liveState === 'fallback-transcribing'
                  }
                >
                  <RotateCcw size={18} aria-hidden />
                  Retry
                </button>
              </div>
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
                onClick={() => navigator.clipboard.writeText(displayedTranscriptText)}
                disabled={!displayedTranscriptText}
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
            value={displayedTranscriptText}
            placeholder="Transcript text appears here. You can edit it before copying or exporting."
            onChange={(event) => {
              setTranscript((current) => ({
                ...current,
                text: event.target.value,
                // Whole-document edits cannot be aligned to the source segments.
                segments: []
              }));
              discardLiveDraft();
            }}
          />
          {trackerNotice ? (
            <p className="error" role="alert">
              {trackerNotice}
            </p>
          ) : null}

          <div className="export-row" aria-label="Export transcript">
            <button
              type="button"
              onClick={() => download('transcript.txt', exportTxt(exportDocument), 'text/plain')}
              disabled={!displayedTranscriptText}
            >
              <Download size={17} aria-hidden />
              TXT
            </button>
            <button
              type="button"
              onClick={() =>
                download('transcript.json', exportJson(exportDocument), 'application/json')
              }
              disabled={!displayedTranscriptText}
            >
              <Download size={17} aria-hidden />
              JSON
            </button>
            <button
              type="button"
              onClick={() =>
                download(
                  'transcript.srt',
                  exportSrt(exportDocument.segments),
                  'application/x-subrip'
                )
              }
              disabled={!canExportTimed}
              aria-describedby="timed-export-help"
            >
              <Download size={17} aria-hidden />
              SRT
            </button>
            <button
              type="button"
              onClick={() =>
                download('transcript.vtt', exportVtt(exportDocument.segments), 'text/vtt')
              }
              disabled={!canExportTimed}
              aria-describedby="timed-export-help"
            >
              <Download size={17} aria-hidden />
              VTT
            </button>
          </div>
          <p id="timed-export-help" className="state-detail">
            TXT/JSON export the current text, including live updates. SRT/VTT require original
            segment timestamps. Editing text or adding live speech removes those timestamps; JSON
            then includes an empty segments list.
          </p>
        </div>
      </section>
    </main>
  );
}
