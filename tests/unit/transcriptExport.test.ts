import { describe, expect, it } from 'vitest';

import {
  exportJson,
  exportSrt,
  exportTxt,
  exportVtt,
  hasTimestamps
} from '@/src/lib/transcriptExport';

const document = {
  text: 'Hello world.',
  language: 'en',
  model: 'gpt-4o-mini-transcribe',
  createdAt: '2026-06-10T00:00:00.000Z',
  segments: [{ start: 1.25, end: 2.5, text: 'Hello world.' }]
};

describe('transcript exports', () => {
  it('exports plain text', () => {
    expect(exportTxt(document)).toBe('Hello world.\n');
  });

  it('exports JSON with metadata', () => {
    expect(JSON.parse(exportJson(document))).toMatchObject({
      text: 'Hello world.',
      language: 'en',
      model: 'gpt-4o-mini-transcribe'
    });
  });

  it('exports SRT and VTT when timestamps exist', () => {
    expect(hasTimestamps(document)).toBe(true);
    expect(exportSrt(document.segments)).toContain('00:00:01,250 --> 00:00:02,500');
    expect(exportVtt(document.segments)).toContain('WEBVTT');
    expect(exportVtt(document.segments)).toContain('00:00:01.250 --> 00:00:02.500');
  });

  it('rounds sub-second timestamps instead of truncating floating-point error', () => {
    const segments = [
      { start: 1.001, end: 2.009, text: 'a' },
      { start: 0.29, end: 59.9999, text: 'b' },
      { start: 3661.123, end: 3661.5, text: 'c' }
    ];
    const srt = exportSrt(segments);
    expect(srt).toContain('00:00:01,001 --> 00:00:02,009');
    expect(srt).toContain('00:00:00,290 --> 00:01:00,000');
    expect(srt).toContain('01:01:01,123 --> 01:01:01,500');
    const vtt = exportVtt(segments);
    expect(vtt).toContain('00:00:01.001 --> 00:00:02.009');
    expect(vtt).toContain('00:00:00.290 --> 00:01:00.000');
  });

  it('clamps negative and non-finite timestamps to zero', () => {
    expect(exportSrt([{ start: -1, end: Number.NaN, text: 'x' }])).toContain(
      '00:00:00,000 --> 00:00:00,000'
    );
  });
});
