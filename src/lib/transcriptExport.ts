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
  // Work in whole milliseconds, rounded, so values such as 1.001s (stored as
  // 1.000999...) are not truncated to 1.000s by floating-point error.
  const totalMs = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}${separator}${pad(milliseconds, 3)}`;
};

export const exportTxt = (document: TranscriptDocument) => document.text.trimEnd() + '\n';

export const exportJson = (document: TranscriptDocument) =>
  JSON.stringify(
    {
      text: document.text,
      language: document.language,
      model: document.model,
      createdAt: document.createdAt,
      segments: document.segments ?? []
    },
    null,
    2
  ) + '\n';

export const exportSrt = (segments: TranscriptSegment[] = []) =>
  segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.start, ',')} --> ${formatTimestamp(
          segment.end,
          ','
        )}\n${segment.text.trim()}\n`
    )
    .join('\n');

export const exportVtt = (segments: TranscriptSegment[] = []) =>
  `WEBVTT\n\n${segments
    .map(
      (segment) =>
        `${formatTimestamp(segment.start, '.')} --> ${formatTimestamp(segment.end, '.')}\n${segment.text.trim()}\n`
    )
    .join('\n')}`;

export const hasTimestamps = (document: TranscriptDocument) =>
  Boolean(
    document.segments?.some(
      (segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end)
    )
  );
