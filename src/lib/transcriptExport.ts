export type TranscriptSegment = {
  id?: number;
  start: number;
  end: number;
  text: string;
};

export type TranscriptDocument = {
  text: string;
  language?: string;
  model?: string;
  createdAt?: string;
  segments?: TranscriptSegment[];
};

const pad = (value: number, digits = 2) => value.toString().padStart(digits, '0');

const formatTimestamp = (seconds: number, separator: ',' | '.') => {
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}${separator}${pad(milliseconds, 3)}`;
};

const validCueText = (text: string) => {
  if (text.includes('-->') || text.split('\n').some((line) => !line.trim())) return false;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) return false;
  }
  return true;
};

const validSegments = (segments: unknown): TranscriptSegment[] | undefined => {
  if (!Array.isArray(segments) || segments.length === 0) return undefined;

  const valid: TranscriptSegment[] = [];
  let previousStart = 0;

  for (const value of segments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const segment = value as Record<string, unknown>;
    const { id, start, end, text } = segment;
    if (
      (id !== undefined && (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)) ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < previousStart ||
      end <= start ||
      !Number.isSafeInteger(Math.round(start * 1000)) ||
      !Number.isSafeInteger(Math.round(end * 1000)) ||
      Math.round(end * 1000) <= Math.round(start * 1000) ||
      typeof text !== 'string' ||
      !validCueText(text)
    ) {
      return undefined;
    }
    valid.push({ ...(typeof id === 'number' ? { id } : {}), start, end, text });
    previousStart = start;
  }

  return valid;
};

const normalizedText = (text: string) => text.trim().replace(/\s+/g, ' ');

export const alignedTranscriptSegments = (
  text: unknown,
  segments: unknown
): TranscriptSegment[] | undefined => {
  const valid = validSegments(segments);
  if (typeof text !== 'string' || !valid) return undefined;

  const original = normalizedText(text);
  const joined = normalizedText(valid.map((segment) => segment.text).join(''));
  const spaced = normalizedText(valid.map((segment) => segment.text).join(' '));
  return original && (original === joined || original === spaced) ? valid : undefined;
};

export const exportTxt = (document: TranscriptDocument) =>
  document.text + (document.text.endsWith('\n') ? '' : '\n');

export const exportJson = (document: TranscriptDocument) =>
  JSON.stringify(
    {
      text: document.text,
      language: document.language,
      model: document.model,
      createdAt: document.createdAt,
      segments: alignedTranscriptSegments(document.text, document.segments) ?? []
    },
    null,
    2
  ) + '\n';

export const exportSrt = (segments: TranscriptSegment[] = []) => {
  const valid = validSegments(segments);
  if (!valid) return '';
  return valid
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.start, ',')} --> ${formatTimestamp(
          segment.end,
          ','
        )}\n${segment.text}\n`
    )
    .join('\n');
};

export const exportVtt = (segments: TranscriptSegment[] = []) => {
  const valid = validSegments(segments);
  if (!valid) return '';
  return `WEBVTT\n\n${valid
    .map(
      (segment) =>
        `${formatTimestamp(segment.start, '.')} --> ${formatTimestamp(segment.end, '.')}\n${segment.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}\n`
    )
    .join('\n')}`;
};

export const hasTimestamps = (document: TranscriptDocument) =>
  Boolean(alignedTranscriptSegments(document.text, document.segments));
