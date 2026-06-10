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
});
