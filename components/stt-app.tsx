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
import {
  LiveUtterances,
  incompleteLiveContentLabel,
  joinTranscriptText,
  unconfirmedLiveIdentityLabel
} from '@/src/lib/liveTranscript';

type Mode = 'live' | 'upload';
type UploadState = 'idle' | 'validating' | 'uploading' | 'done' | 'error';
type LiveState =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'live'
  | 'fallback-recording'
  | 'fallback-ready'
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
const unconfirmedLiveItemLabel = '[Live item; order unconfirmed]';
const unconfirmedEditedTextLabel = '[Edited live text; order unconfirmed]';
const unconfirmedEditedIdentityLabel = '[Edited live text; event identity unconfirmed]';
const nonAudioRealtimeItemTypes = new Set([
  'function_call',
  'function_call_output',
  'mcp_approval_request',
  'mcp_approval_response',
  'mcp_list_tools',
  'mcp_call'
]);
const nonAudioRealtimeContentTypes = new Set([
  'input_text',
  'text',
  'output_text',
  'input_image',
  'output_audio'
]);

const selectedRealtimeModel = (value: string | null | undefined) =>
  value && value.length <= 256 && /^[\x21-\x7e]+$/.test(value) ? value : undefined;

const retainEditedWarning = (text: string, label: string, otherLabel: string) =>
  text.startsWith(`${label}\n`) || text.startsWith(`${otherLabel}\n${label}\n`)
    ? text
    : `${label}\n${text}`;

const appendDocumentText = (
  current: TranscriptDocument,
  text: string,
  model: string | undefined,
  language: string | undefined
): TranscriptDocument => {
  if (!text) return current;
  const hasExistingText = current.text.length > 0;
  return {
    ...current,
    text: joinTranscriptText(current.text, text),
    segments: [],
    model: hasExistingText
      ? current.model && model
        ? current.model === model
          ? model
          : 'mixed'
        : undefined
      : model,
    language: hasExistingText
      ? current.language && language && current.language !== 'auto' && current.language === language
        ? language
        : undefined
      : language,
    createdAt: current.createdAt || new Date().toISOString()
  };
};

const stopRecorder = (recorder: MediaRecorder) => {
  try {
    if (recorder.state !== 'inactive') recorder.stop();
    return true;
  } catch {
    return false;
  }
};

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
  'fallback-ready': {
    label: 'Recording interrupted',
    detail: 'Capture stopped. Choose whether to transcribe or discard the retained recording.'
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

const serializeRealtimeEvent = (event: Record<string, unknown>) =>
  JSON.stringify(event, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        )
      : value
  ) ?? '';

export function SttApp() {
  const [mode, setMode] = useState<Mode>('live');
  const [language, setLanguage] = useState('en');
  const [liveLanguage, setLiveLanguage] = useState(language);
  const [liveModel, setLiveModel] = useState<string | undefined>();
  const [fileModel, setFileModel] = useState<FileSttModel>(sttModels.fileDefault);
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadError, setUploadError] = useState('');
  const [liveState, setLiveState] = useState<LiveState>('idle');
  const [liveError, setLiveError] = useState('');
  const [trackerNotice, setTrackerNotice] = useState('');
  const [partial, setPartial] = useState('');
  const [orderUncertain, setOrderUncertain] = useState(false);
  const [identityUncertain, setIdentityUncertain] = useState(false);
  const [referencePending, setReferencePending] = useState(false);
  const [referenceOmitted, setReferenceOmitted] = useState(false);
  const [contentOmitted, setContentOmitted] = useState(false);
  const [editedOrderUncertain, setEditedOrderUncertain] = useState(false);
  const [editedIdentityUncertain, setEditedIdentityUncertain] = useState(false);
  const [channelReady, setChannelReady] = useState(false);
  const [turnPending, setTurnPending] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptDocument>(emptyTranscript);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const turnPendingRef = useRef<string | null>(null);
  const turnSequenceRef = useRef(0);
  const liveLanguageRef = useRef(language);
  const liveModelRef = useRef<string | undefined>(undefined);
  const utterancesRef = useRef(new LiveUtterances(false));
  const liveSessionRef = useRef(0);
  const pendingSetupRef = useRef<number | null>(null);
  const editedOrderUncertainRef = useRef(false);
  const labeledOrderUncertainRef = useRef(false);
  const editedIdentityUncertainRef = useRef(false);
  const labeledIdentityUncertainRef = useRef(false);
  const realtimeRequestRef = useRef<AbortController | null>(null);
  const fallbackRequestRef = useRef<AbortController | null>(null);
  const fallbackUploadRef = useRef<AbortController | null>(null);
  const fallbackStopRequestedRef = useRef(false);
  const pendingFallbackRef = useRef<(() => void) | null>(null);
  const uploadRequestRef = useRef<AbortController | null>(null);

  const transcriptText = transcript.text;
  const displayedTranscriptText = joinTranscriptText(transcriptText, partial);
  const currentDocument = appendDocumentText(transcript, partial, liveModel, liveLanguage);
  const exportDocument =
    contentOmitted && !currentDocument.text.includes(incompleteLiveContentLabel)
      ? {
          ...currentDocument,
          text: `${currentDocument.text}${currentDocument.text ? '\n\n' : ''}${incompleteLiveContentLabel}`,
          segments: []
        }
      : currentDocument;
  const exportUncertain =
    orderUncertain ||
    editedOrderUncertain ||
    identityUncertain ||
    editedIdentityUncertain ||
    referencePending;
  const canExportTimed = !exportUncertain && !contentOmitted && hasTimestamps(exportDocument);
  const liveStatus = liveStatusCopy[liveState];

  const fileHelp = useMemo(
    () =>
      `Max ${Math.floor(appLimits.maxUploadBytes / 1024 / 1024)} MB. Audio and video files accepted.`,
    []
  );

  const applyFinalText = useCallback((text: string) => {
    if (text.includes(unconfirmedLiveItemLabel)) labeledOrderUncertainRef.current = true;
    if (text.includes(unconfirmedLiveIdentityLabel)) labeledIdentityUncertainRef.current = true;
    const sessionLanguage = liveLanguageRef.current;
    const sessionModel = liveModelRef.current;
    setTranscript((current) => appendDocumentText(current, text, sessionModel, sessionLanguage));
  }, []);

  const finishLiveTracker = useCallback(() => {
    const tracker = utterancesRef.current;
    if (tracker.referenceUncertain) setReferenceOmitted(true);
    if (tracker.contentIncomplete) setContentOmitted(true);
    setReferencePending(false);
    return tracker.finish();
  }, []);

  const retirePeer = useCallback(() => {
    const channel = dataChannelRef.current;
    dataChannelRef.current = null;
    if (channel) {
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
    }
    turnPendingRef.current = null;
    setTurnPending(false);
    setChannelReady(false);
    const peer = peerConnectionRef.current;
    peerConnectionRef.current = null;
    if (peer) {
      peer.onconnectionstatechange = null;
      peer.close();
    }
  }, []);

  const stopMedia = useCallback(() => {
    liveSessionRef.current += 1;
    pendingSetupRef.current = null;
    realtimeRequestRef.current?.abort();
    realtimeRequestRef.current = null;
    retirePeer();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [retirePeer]);

  const cancelUpload = useCallback(() => {
    const request = uploadRequestRef.current;
    uploadRequestRef.current = null;
    if (request) {
      request.abort();
      setUploadState('idle');
    }
  }, []);

  const discardLiveDraft = useCallback(() => {
    const fallback = fallbackRequestRef.current;
    const fallbackUploading = fallback !== null && fallbackUploadRef.current === fallback;
    const setupPending = pendingSetupRef.current !== null;
    fallbackRequestRef.current = null;
    fallbackUploadRef.current = null;
    fallbackStopRequestedRef.current = false;
    pendingFallbackRef.current = null;
    fallback?.abort();
    if (fallback || setupPending) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        stopRecorder(recorder);
      }
      stopMedia();
      setLiveState('stopped');
      setLiveError('');
    }
    const tracker = utterancesRef.current;
    if (tracker.referenceUncertain) setReferenceOmitted(true);
    if (tracker.contentIncomplete) setContentOmitted(true);
    setReferencePending(false);
    tracker.discard();
    setPartial('');
    setOrderUncertain(false);
    setIdentityUncertain(false);
    if (fallback) {
      setTrackerNotice(
        fallbackUploading
          ? 'Cancellation was requested for the local recording transcription because the workspace changed. Its result will be discarded; audio already sent cannot be retracted and may already have been transcribed.'
          : 'The local recording was discarded because the workspace changed; it will not be transcribed.'
      );
    } else if (setupPending) {
      setTrackerNotice(
        'Live setup stopped because the workspace changed. Start a new session to resume; audio already sent cannot be retracted.'
      );
    } else if (tracker.error) {
      setTrackerNotice(tracker.error);
    }
  }, [stopMedia]);

  useEffect(() => {
    return () => {
      uploadRequestRef.current?.abort();
      uploadRequestRef.current = null;
      fallbackRequestRef.current?.abort();
      fallbackRequestRef.current = null;
      fallbackUploadRef.current = null;
      fallbackStopRequestedRef.current = false;
      pendingFallbackRef.current = null;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        // Unmount releases capture without uploading an abandoned recording.
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        stopRecorder(recorder);
      }
      stopMedia();
    };
  }, [stopMedia]);

  const transcribeFallbackRecording = useCallback(
    async (blob: Blob, extension: string, signal: AbortSignal) => {
      const fallbackFile = new File([blob], `live-recording-${Date.now()}.${extension}`, {
        type: blob.type
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
    (stream: MediaStream, session: number, reason: string) => {
      const request = new AbortController();
      fallbackRequestRef.current = request;
      fallbackStopRequestedRef.current = false;
      pendingFallbackRef.current = null;
      const chunks: Blob[] = [];
      const fallbackTracker = utterancesRef.current;
      const fallbackLiveModel = liveModelRef.current;
      const fallbackLiveLanguage = liveLanguageRef.current;
      const formats = [
        { mimeType: 'audio/webm', extension: 'webm' },
        { mimeType: 'audio/ogg', extension: 'ogg' },
        { mimeType: 'audio/mp4', extension: 'mp4' }
      ];
      const format = formats.find(
        (candidate) =>
          typeof MediaRecorder.isTypeSupported !== 'function' ||
          MediaRecorder.isTypeSupported(candidate.mimeType)
      );
      if (!format) throw new Error('No supported local recording format is available.');
      const recorder = new MediaRecorder(stream, { mimeType: format.mimeType });
      const isCurrent = () => fallbackRequestRef.current === request && !request.signal.aborted;
      const releaseOwnedMedia = () => {
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (session === liveSessionRef.current && streamRef.current === stream) stopMedia();
      };
      let stopped = false;
      recorder.ondataavailable = (event) => {
        if (isCurrent() && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (!isCurrent() || stopped) return;
        stopped = true;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        releaseOwnedMedia();
        stopRecorder(recorder);
        pendingFallbackRef.current = () => void transcribe();
        setLiveError(
          'Recording failed. Audio received so far may be incomplete; choose whether to transcribe or discard it.'
        );
        setLiveState('fallback-ready');
      };
      const transcribe = async () => {
        if (!isCurrent()) return;
        pendingFallbackRef.current = null;
        setLiveError('');
        try {
          setLiveState('fallback-transcribing');
          const blob = new Blob(chunks, { type: format.mimeType });
          fallbackUploadRef.current = request;
          const document = await transcribeFallbackRecording(
            blob,
            format.extension,
            request.signal
          );
          if (!isCurrent()) return;
          const remaining = utterancesRef.current === fallbackTracker ? finishLiveTracker() : '';
          if (remaining.includes(unconfirmedLiveItemLabel)) {
            labeledOrderUncertainRef.current = true;
          }
          if (remaining.includes(unconfirmedLiveIdentityLabel)) {
            labeledIdentityUncertainRef.current = true;
          }
          setTranscript((current) => {
            const withPending = appendDocumentText(
              current,
              remaining,
              fallbackLiveModel,
              fallbackLiveLanguage
            );
            return appendDocumentText(
              withPending,
              document.text,
              document.model,
              document.language
            );
          });
          setPartial('');
          setOrderUncertain(false);
          setIdentityUncertain(false);
          setLiveState('stopped');
        } catch (error) {
          if (!isCurrent()) return;
          if (utterancesRef.current === fallbackTracker) {
            const remaining = finishLiveTracker();
            if (remaining) applyFinalText(remaining);
            setPartial('');
            setOrderUncertain(false);
            setIdentityUncertain(false);
          }
          setLiveError(error instanceof Error ? error.message : 'Fallback transcription failed.');
          setLiveState('error');
        } finally {
          // This callback owns only its request; it must never close a newer session's media.
          if (fallbackRequestRef.current === request) fallbackRequestRef.current = null;
          if (fallbackUploadRef.current === request) fallbackUploadRef.current = null;
        }
      };
      recorder.onstop = () => {
        if (!isCurrent() || stopped) return;
        stopped = true;
        const requested = fallbackStopRequestedRef.current;
        fallbackStopRequestedRef.current = false;
        releaseOwnedMedia();
        if (requested) {
          void transcribe();
        } else {
          pendingFallbackRef.current = () => void transcribe();
          setLiveError(
            'Recording stopped unexpectedly. Its audio remains in this tab until you choose what to do.'
          );
          setLiveState('fallback-ready');
        }
      };
      recorderRef.current = recorder;
      recorder.start(1_000);
      if (!isCurrent() || stopped) return;
      setLiveError(`${reason} Recording locally in this tab and transcribing after Stop.`);
      setLiveState('fallback-recording');
    },
    [applyFinalText, finishLiveTracker, stopMedia, transcribeFallbackRecording]
  );

  const cancelFallbackRecorder = useCallback(() => {
    fallbackRequestRef.current?.abort();
    fallbackRequestRef.current = null;
    fallbackUploadRef.current = null;
    fallbackStopRequestedRef.current = false;
    pendingFallbackRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      stopRecorder(recorder);
    }
  }, []);

  const startLive = useCallback(async () => {
    cancelUpload();
    const discardedRecording = Boolean(
      fallbackRequestRef.current && (recorderRef.current || pendingFallbackRef.current)
    );
    cancelFallbackRecorder();
    const remaining = finishLiveTracker();
    if (remaining) applyFinalText(remaining);
    stopMedia();
    const session = ++liveSessionRef.current;
    pendingSetupRef.current = session;
    liveLanguageRef.current = language;
    setLiveLanguage(language);
    liveModelRef.current = undefined;
    setLiveModel(undefined);
    setLiveError('');
    utterancesRef.current = new LiveUtterances();
    setTrackerNotice(
      discardedRecording ? 'The previous local recording was discarded on Retry.' : ''
    );
    setReferencePending(false);
    setPartial('');
    setOrderUncertain(false);
    setIdentityUncertain(false);
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
        if (session !== liveSessionRef.current || peerConnectionRef.current !== pc) return;
        if (pc.connectionState === 'connected') setLiveState('live');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          const remaining = finishLiveTracker();
          if (remaining) applyFinalText(remaining);
          setPartial('');
          setOrderUncertain(false);
          setIdentityUncertain(false);
          stopMedia();
          setLiveError('Realtime connection was interrupted. Stop and retry.');
          setLiveState('error');
        }
      };

      const channel = pc.createDataChannel('oai-events');
      dataChannelRef.current = channel;
      const ownsChannel = () =>
        session === liveSessionRef.current &&
        peerConnectionRef.current === pc &&
        dataChannelRef.current === channel;
      channel.onopen = () => {
        if (ownsChannel()) setChannelReady(true);
      };
      const handleChannelClose = () => {
        if (!ownsChannel()) return;
        const remaining = finishLiveTracker();
        if (remaining) applyFinalText(remaining);
        setPartial('');
        setOrderUncertain(false);
        setIdentityUncertain(false);
        stopMedia();
        setLiveError(
          'Realtime data channel closed. Capture stopped; uncommitted audio and any pending transcription may be lost. Audio already sent cannot be retracted. Retry to start a new session.'
        );
        setLiveState('error');
      };
      channel.onclose = handleChannelClose;
      if (channel.readyState === 'closed') {
        handleChannelClose();
        return;
      }
      if (channel.readyState === 'open') setChannelReady(true);
      channel.onmessage = (message) => {
        if (!ownsChannel()) return;
        const tracker = utterancesRef.current;
        const syncTracker = () => {
          if (tracker.error) setTrackerNotice(tracker.error);
          if (tracker.contentIncomplete) setContentOmitted(true);
          setPartial(tracker.preview());
          setOrderUncertain(tracker.orderUncertain);
          setIdentityUncertain(tracker.identityUncertain);
          setReferencePending(tracker.referenceUncertain);
        };
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
          let audioPartIndex = -1;
          let audioPartCount = 0;
          if (isCreated) {
            content.forEach((part: unknown, index: number) => {
              if (
                part &&
                typeof part === 'object' &&
                !Array.isArray(part) &&
                (part as Record<string, unknown>).type === 'input_audio'
              ) {
                audioPartIndex = index;
                audioPartCount += 1;
              }
            });
          }
          const onlyPart = content[0];
          const referencePart =
            isCreated &&
            item?.type === 'message' &&
            item.role === 'user' &&
            content.length === 1 &&
            onlyPart &&
            typeof onlyPart === 'object' &&
            !Array.isArray(onlyPart) &&
            (onlyPart as Record<string, unknown>).type === 'input_audio'
              ? (onlyPart as Record<string, unknown>)
              : undefined;
          const referenceTranscript =
            typeof referencePart?.transcript === 'string' ? referencePart.transcript : undefined;
          const isAudioBufferEvent = [
            'input_audio_buffer.speech_started',
            'input_audio_buffer.speech_stopped',
            'input_audio_buffer.committed'
          ].includes(type);
          const isTranscriptionEvent = type.startsWith(
            'conversation.item.input_audio_transcription.'
          );
          if (isCreated && audioPartCount > 1) {
            tracker.rejectContent('an item contains multiple unsupported audio content parts.');
          } else if (isCreated && audioPartCount === 1) {
            tracker.validateContentIndex(item?.id, audioPartIndex);
          } else if (isTranscriptionEvent) {
            tracker.validateContentIndex(parsed.item_id, parsed.content_index);
          }
          const eventIdentity = tracker.trackEvent(
            parsed.event_id,
            parsed.event_id == null ? '' : serializeRealtimeEvent(parsed)
          );
          if (eventIdentity === 'duplicate' || eventIdentity === 'rejected') {
            syncTracker();
            return;
          }
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
                key === 'transcript' &&
                ((value === parsed &&
                  type === 'conversation.item.input_audio_transcription.completed') ||
                  (value === referencePart && typeof child === 'string'));
              if (
                ['transcript', 'transcript_delta', 'final_transcript'].includes(key) &&
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
            const isAudio = audioPartIndex !== -1;
            const hasNonAudioContent = content.some((part: unknown) => {
              if (!part || typeof part !== 'object') return false;
              const partType = (part as Record<string, unknown>).type;
              return typeof partType === 'string' && nonAudioRealtimeContentTypes.has(partType);
            });
            const itemType = item?.type;
            const hasNonAudio =
              (typeof itemType === 'string' && nonAudioRealtimeItemTypes.has(itemType)) ||
              item?.role === 'system' ||
              item?.role === 'assistant' ||
              hasNonAudioContent;
            if (isAudio && hasNonAudio) {
              tracker.reject('an item contains conflicting audio and non-audio identity.');
            } else {
              committed = hasNonAudio
                ? tracker.skip(item?.id, parsed.previous_item_id)
                : referenceTranscript !== undefined
                  ? tracker.registerReference(
                      item?.id,
                      parsed.previous_item_id,
                      referenceTranscript
                    )
                  : isAudio
                    ? tracker.registerAudioPart(item?.id, parsed.previous_item_id, audioPartIndex)
                    : tracker.register(item?.id, parsed.previous_item_id);
            }
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
              committed = tracker.fail(
                parsed.item_id,
                parsed.previous_item_id,
                undefined,
                parsed.content_index
              );
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
                undefined,
                parsed.previous_item_id,
                eventIdentity === 'unidentified',
                parsed.content_index
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
          const firstAcknowledgement =
            !tracker.error && type === 'input_audio_buffer.committed'
              ? tracker.acknowledge(parsed.item_id)
              : false;
          if (!tracker.error && turnPendingRef.current) {
            if (type === 'input_audio_buffer.committed') {
              if (eventIdentity === 'accepted' && firstAcknowledgement) {
                turnPendingRef.current = null;
                setTurnPending(false);
                setLiveError('');
              } else {
                setLiveError(
                  'The turn acknowledgement cannot be verified for this pending turn. Its outcome is unknown; Stop and retry, or wait for a new identified acknowledgement.'
                );
              }
            } else if (type === 'error') {
              if (
                parsed.error &&
                typeof parsed.error === 'object' &&
                !Array.isArray(parsed.error) &&
                (parsed.error as Record<string, unknown>).event_id === turnPendingRef.current
              ) {
                turnPendingRef.current = null;
                setTurnPending(false);
                setLiveError('The audio turn was not accepted. Retry while connected.');
              } else {
                setLiveError(
                  'A realtime error occurred, but the pending turn outcome is unknown. Wait for an identified acknowledgement, or Stop and retry; another turn cannot be submitted yet.'
                );
              }
            }
          } else if (!tracker.error && type === 'error') {
            setLiveError(
              'A realtime error was reported. Check the transcript, or Stop and retry if needed.'
            );
          }
        } catch {
          tracker.reject('a realtime event was malformed or too large.');
        }
        syncTracker();
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

      const model = selectedRealtimeModel(answer.headers?.get('X-STT-Model'));
      liveModelRef.current = model;
      setLiveModel(model);
      const sdp = await answer.text();
      if (session !== liveSessionRef.current) return;
      await pc.setRemoteDescription({ type: 'answer', sdp });
      if (session !== liveSessionRef.current) return;
      pendingSetupRef.current = null;
    } catch (error) {
      if (session !== liveSessionRef.current) return;
      const message =
        error instanceof Error ? error.message : 'Realtime transcription is unavailable.';
      if (
        streamRef.current &&
        typeof MediaRecorder !== 'undefined' &&
        shouldAttemptLocalRecordingFallback(error)
      ) {
        retirePeer();
        pendingSetupRef.current = null;
        try {
          startFallbackRecorder(streamRef.current, session, message);
          return;
        } catch (fallbackError) {
          cancelFallbackRecorder();
          const remaining = finishLiveTracker();
          if (remaining) applyFinalText(remaining);
          setPartial('');
          setOrderUncertain(false);
          setIdentityUncertain(false);
          stopMedia();
          setLiveError(
            fallbackError instanceof Error
              ? fallbackError.message
              : 'Local recording could not start.'
          );
          setLiveState('error');
          return;
        }
      }
      setLiveError(
        `${message} Check OpenAI billing/model access and restart the app after updating server-side secrets.`
      );
      setLiveState('error');
      const remaining = finishLiveTracker();
      if (remaining) applyFinalText(remaining);
      setPartial('');
      setOrderUncertain(false);
      setIdentityUncertain(false);
      stopMedia();
    }
  }, [
    applyFinalText,
    cancelFallbackRecorder,
    cancelUpload,
    finishLiveTracker,
    language,
    retirePeer,
    startFallbackRecorder,
    stopMedia
  ]);

  const resolveEditedOrder = useCallback((withLabel: boolean) => {
    if (!editedOrderUncertainRef.current) return;
    editedOrderUncertainRef.current = false;
    setEditedOrderUncertain(false);
    labeledOrderUncertainRef.current = withLabel;
    if (withLabel) {
      setTranscript((current) => ({
        ...current,
        text: retainEditedWarning(
          current.text,
          unconfirmedEditedTextLabel,
          unconfirmedEditedIdentityLabel
        )
      }));
    }
  }, []);

  const resolveEditedIdentity = useCallback((withLabel: boolean) => {
    if (!editedIdentityUncertainRef.current) return;
    editedIdentityUncertainRef.current = false;
    setEditedIdentityUncertain(false);
    labeledIdentityUncertainRef.current = withLabel;
    if (withLabel) {
      setTranscript((current) => ({
        ...current,
        text: retainEditedWarning(
          current.text,
          unconfirmedEditedIdentityLabel,
          unconfirmedEditedTextLabel
        )
      }));
    }
  }, []);

  const stopLive = useCallback(() => {
    if (recorderRef.current) {
      resolveEditedOrder(true);
      resolveEditedIdentity(true);
      const recorder = recorderRef.current;
      recorderRef.current = null;
      fallbackStopRequestedRef.current = true;
      stopMedia();
      setLiveState(
        fallbackRequestRef.current?.signal.aborted ? 'stopped' : 'fallback-transcribing'
      );
      if (!stopRecorder(recorder)) {
        fallbackRequestRef.current?.abort();
        fallbackRequestRef.current = null;
        fallbackStopRequestedRef.current = false;
        recorder.onstop = null;
        const remaining = finishLiveTracker();
        if (remaining) applyFinalText(remaining);
        setPartial('');
        setOrderUncertain(false);
        setIdentityUncertain(false);
        setLiveError('Local recording could not stop and was discarded. Retry to start again.');
        setLiveState('error');
      }
      return;
    }

    const remaining = finishLiveTracker();
    if (remaining) applyFinalText(remaining);
    resolveEditedOrder(true);
    resolveEditedIdentity(true);
    stopMedia();
    setPartial('');
    setOrderUncertain(false);
    setIdentityUncertain(false);
    setLiveState('stopped');
  }, [applyFinalText, finishLiveTracker, resolveEditedIdentity, resolveEditedOrder, stopMedia]);

  const discardPendingRecording = () => {
    if (!pendingFallbackRef.current) return;
    pendingFallbackRef.current = null;
    fallbackRequestRef.current?.abort();
    fallbackRequestRef.current = null;
    const remaining = finishLiveTracker();
    if (remaining) applyFinalText(remaining);
    setPartial('');
    setOrderUncertain(false);
    setIdentityUncertain(false);
    setLiveError('The retained local recording was discarded without transcription.');
    setLiveState('stopped');
  };

  const finishTurn = () => {
    const channel = dataChannelRef.current;
    if (
      !channel ||
      channel.readyState !== 'open' ||
      turnPendingRef.current ||
      utterancesRef.current.error
    )
      return;
    const clientEventId = `turn-${liveSessionRef.current}-${++turnSequenceRef.current}`;
    try {
      setLiveError('');
      turnPendingRef.current = clientEventId;
      setTurnPending(true);
      channel.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: clientEventId }));
    } catch {
      if (dataChannelRef.current !== channel || turnPendingRef.current !== clientEventId) return;
      turnPendingRef.current = null;
      setTurnPending(false);
      setLiveError('The audio turn could not be submitted. Retry while connected.');
    }
  };

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

    cancelUpload();
    const request = new AbortController();
    uploadRequestRef.current = request;
    const isCurrent = () => uploadRequestRef.current === request && !request.signal.aborted;
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
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body,
        signal: request.signal
      });
      if (!response.ok) throw await readApiFailure(response);

      const data = (await response.json()) as { transcript: TranscriptDocument };
      if (!isCurrent()) return;
      discardLiveDraft();
      setReferencePending(false);
      setReferenceOmitted(false);
      setContentOmitted(false);
      resolveEditedOrder(false);
      resolveEditedIdentity(false);
      labeledOrderUncertainRef.current = false;
      labeledIdentityUncertainRef.current = false;
      setTranscript(data.transcript);
      setUploadState('done');
    } catch (error) {
      if (!isCurrent()) return;
      setUploadError(error instanceof Error ? error.message : 'Upload transcription failed.');
      setUploadState('error');
    } finally {
      if (uploadRequestRef.current === request) uploadRequestRef.current = null;
    }
  };

  const clearWorkspace = () => {
    cancelUpload();
    resolveEditedOrder(false);
    resolveEditedIdentity(false);
    labeledOrderUncertainRef.current = false;
    labeledIdentityUncertainRef.current = false;
    setTranscript(emptyTranscript);
    discardLiveDraft();
    setReferencePending(false);
    setReferenceOmitted(false);
    setContentOmitted(false);
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
                    liveState === 'fallback-ready' ||
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
                  onClick={finishTurn}
                  disabled={
                    liveState !== 'live' ||
                    !channelReady ||
                    turnPending ||
                    trackerNotice.startsWith('Live transcription paused:')
                  }
                >
                  Finish turn
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
              {liveState === 'fallback-ready' ? (
                <div className="button-row">
                  <button type="button" onClick={() => pendingFallbackRef.current?.()}>
                    Transcribe recording
                  </button>
                  <button type="button" onClick={discardPendingRecording}>
                    Discard recording
                  </button>
                </div>
              ) : null}
              <p className="state-detail">
                Finish turn submits the current audio for transcription while listening continues.
                Wait for its result before Stop; Stop releases capture immediately.
              </p>
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
                  onChange={(event) => {
                    cancelUpload();
                    setFile(event.target.files?.[0] || null);
                  }}
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
                onClick={() => navigator.clipboard.writeText(exportDocument.text)}
                disabled={!exportDocument.text || exportUncertain}
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
              cancelUpload();
              const value = event.target.value;
              const retainsUncertainty =
                editedOrderUncertainRef.current ||
                labeledOrderUncertainRef.current ||
                (orderUncertain && Boolean(partial)) ||
                (utterancesRef.current.orderUncertain &&
                  Boolean(utterancesRef.current.preview())) ||
                displayedTranscriptText.includes(unconfirmedLiveItemLabel) ||
                displayedTranscriptText.includes(unconfirmedEditedTextLabel);
              editedOrderUncertainRef.current = retainsUncertainty;
              setEditedOrderUncertain(retainsUncertainty);
              const retainsIdentityUncertainty =
                editedIdentityUncertainRef.current ||
                labeledIdentityUncertainRef.current ||
                (identityUncertain && Boolean(partial)) ||
                utterancesRef.current.identityUncertain ||
                displayedTranscriptText.includes(unconfirmedLiveIdentityLabel) ||
                displayedTranscriptText.includes(unconfirmedEditedIdentityLabel);
              editedIdentityUncertainRef.current = retainsIdentityUncertainty;
              setEditedIdentityUncertain(retainsIdentityUncertainty);
              setTranscript((current) => ({
                ...current,
                text: value,
                language: undefined,
                model: 'edited',
                // Whole-document edits cannot be aligned to the source segments.
                segments: []
              }));
              discardLiveDraft();
            }}
          />
          {trackerNotice || contentOmitted ? (
            <p className="error" role="alert">
              {trackerNotice}
              {trackerNotice && contentOmitted ? ' ' : ''}
              {contentOmitted ? (
                <>
                  Unsupported or conflicting live audio content may be missing. The content-identity
                  warning is retained in copies and TXT/JSON exports until Clear or a successful
                  replacement upload.
                </>
              ) : null}
            </p>
          ) : null}
          {referencePending ? (
            <p className="error" role="alert">
              A live audio reference transcript is unconfirmed and is not included. Wait for its
              completed transcription, or Stop and review or repeat the missing speech.
              Copy/TXT/JSON are unavailable while waiting.
            </p>
          ) : null}
          {referenceOmitted ? (
            <p className="error" role="alert">
              An unconfirmed live audio reference transcript was not included. Review the transcript
              or repeat the missing speech.
            </p>
          ) : null}
          {orderUncertain ? (
            <p className="error" role="alert">
              Live item order is unconfirmed. The preview is provisional; TXT/JSON are unavailable
              until order is known or Stop preserves the items with explicit uncertainty labels.
            </p>
          ) : null}
          {identityUncertain ? (
            <p className="error" role="alert">
              Live event identity is unconfirmed. Repeated partials may be distinct or duplicate;
              the preview is provisional and Copy/TXT/JSON are unavailable until a final replaces
              the draft or Stop retains it with an explicit warning.
            </p>
          ) : null}
          {editedOrderUncertain ? (
            <div className="state-detail" role="alert">
              <p>
                This edit may retain live text in an unconfirmed order. Later session metadata
                cannot correct it. Keep the uncertainty label, or confirm the displayed order
                yourself. Stop also keeps the text with an uncertainty label; Clear discards it.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => resolveEditedOrder(true)}
                  disabled={!displayedTranscriptText}
                >
                  Keep text with order warning
                </button>
                <button
                  type="button"
                  onClick={() => resolveEditedOrder(false)}
                  disabled={!displayedTranscriptText}
                >
                  Confirm edited order
                </button>
              </div>
            </div>
          ) : null}
          {editedIdentityUncertain ? (
            <div className="state-detail" role="alert">
              <p>
                This edit may retain partial text whose event identity is unconfirmed. Later session
                events cannot correct it. Keep the warning, or confirm the displayed text yourself.
                Stop keeps the warning; Clear discards it.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => resolveEditedIdentity(true)}
                  disabled={!displayedTranscriptText}
                >
                  Keep text with identity warning
                </button>
                <button
                  type="button"
                  onClick={() => resolveEditedIdentity(false)}
                  disabled={!displayedTranscriptText}
                >
                  Confirm edited text
                </button>
              </div>
            </div>
          ) : null}

          <div className="export-row" aria-label="Export transcript">
            <button
              type="button"
              onClick={() => download('transcript.txt', exportTxt(exportDocument), 'text/plain')}
              disabled={!exportDocument.text || exportUncertain}
            >
              <Download size={17} aria-hidden />
              TXT
            </button>
            <button
              type="button"
              onClick={() =>
                download('transcript.json', exportJson(exportDocument), 'application/json')
              }
              disabled={!exportDocument.text || exportUncertain}
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
