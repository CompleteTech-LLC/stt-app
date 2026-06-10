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
  const bounded = Math.max(0, seconds);
  const hours = Math.floor(bounded / 3600);
  const minutes = Math.floor((bounded % 3600) / 60);
  const wholeSeconds = Math.floor(bounded % 60);
  const milliseconds = Math.floor((bounded - Math.floor(bounded)) * 1000);
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
