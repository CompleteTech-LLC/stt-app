export const appLimits = {
  maxUploadBytes: 25 * 1024 * 1024,
  requestTimeoutMs: 120_000,
  realtimeSessionTimeoutMs: 30_000,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 20
} as const;

export const sttModels = {
  realtime: 'gpt-realtime-whisper',
  fileDefault: 'gpt-4o-mini-transcribe',
  fileHighAccuracy: 'gpt-4o-transcribe'
} as const;

export const acceptedMimeTypes = [
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/x-m4v'
] as const;

export const acceptedExtensions = [
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.oga',
  '.ogg',
  '.wav',
  '.webm',
  '.mov',
  '.m4v'
] as const;

export const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'auto', label: 'Auto detect' }
] as const;

export type FileSttModel =
  | (typeof sttModels)['fileDefault']
  | (typeof sttModels)['fileHighAccuracy'];

export const isFileSttModel = (value: string): value is FileSttModel =>
  value === sttModels.fileDefault || value === sttModels.fileHighAccuracy;
