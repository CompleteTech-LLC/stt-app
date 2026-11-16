import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SttApp } from '@/components/stt-app';
import {
  exportJson,
  exportSrt,
  exportTxt,
  exportVtt,
  hasTimestamps,
  type TranscriptSegment
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

  it.each([
    ['line\n\n', 'line\n\n'],
    ['line  ', 'line  \n'],
    ['line\r\n', 'line\r\n'],
    ['\n\n', '\n\n'],
    ['', '\n']
  ])('preserves whitespace in TXT export for %j', (text, expected) => {
    expect(exportTxt({ ...document, text })).toBe(expected);
    expect(JSON.parse(exportJson({ ...document, text })).text).toBe(text);
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
      { start: 0.29, end: 59.9999, text: 'b' },
      { start: 1.001, end: 2.009, text: 'a' },
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

  it('preserves cue whitespace and escapes VTT markup as text', () => {
    const segments = [{ start: 1, end: 2, text: '  A <speaker> & B\n  Next line  ' }];
    expect(exportSrt(segments)).toContain('  A <speaker> & B\n  Next line  \n');
    expect(exportVtt(segments)).toContain('  A &lt;speaker&gt; &amp; B\n  Next line  \n');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', []],
    ['not an array', {}],
    ['a sparse array', new Array(2)],
    ['null cue', [{ start: 0, end: 1, text: 'First' }, null]],
    ['missing start', [{ end: 1, text: 'First second' }]],
    ['null start', [{ start: null, end: 1, text: 'First second' }]],
    ['missing end', [{ start: 0, text: 'First second' }]],
    ['string timestamp', [{ start: '0', end: 1, text: 'First second' }]],
    ['negative time', [{ start: -1, end: 1, text: 'First second' }]],
    ['reversed time', [{ start: 2, end: 1, text: 'First second' }]],
    ['zero duration', [{ start: 1, end: 1, text: 'First second' }]],
    ['duration rounded to zero', [{ start: 1, end: 1.0001, text: 'First second' }]],
    ['NaN', [{ start: 0, end: Number.NaN, text: 'First second' }]],
    ['infinity', [{ start: 0, end: Infinity, text: 'First second' }]],
    ['unsafe milliseconds', [{ start: 0, end: Number.MAX_VALUE, text: 'First second' }]],
    ['missing text', [{ start: 0, end: 1 }]],
    ['null text', [{ start: 0, end: 1, text: null }]],
    ['empty text', [{ start: 0, end: 1, text: '  ' }]],
    ['blank caption line', [{ start: 0, end: 1, text: 'First\n\nsecond' }]],
    ['caption timing injection', [{ start: 0, end: 1, text: 'First --> second' }]],
    ['control character', [{ start: 0, end: 1, text: 'First\rsecond' }]],
    ['invalid id', [{ id: null, start: 0, end: 1, text: 'First second' }]],
    [
      'mixed valid and missing',
      [
        { start: 0, end: 1, text: 'First' },
        { start: null, end: null, text: 'second' }
      ]
    ],
    [
      'out-of-order cues',
      [
        { start: 1, end: 2, text: 'First' },
        { start: 0, end: 1, text: 'second' }
      ]
    ]
  ])('disables and refuses subtitle output for %s segments', (_label, segments) => {
    const text = '  First\nsecond  ';
    const invalid = { text, segments: segments as TranscriptSegment[] };

    expect(hasTimestamps(invalid)).toBe(false);
    expect(exportSrt(invalid.segments)).toBe('');
    expect(exportVtt(invalid.segments)).toBe('');
    expect(exportTxt(invalid)).toBe(`${text}\n`);
    expect(JSON.parse(exportJson(invalid))).toMatchObject({ text, segments: [] });
  });

  it('disables document exports for structurally valid but incomplete alignment', () => {
    const incomplete = {
      text: 'First second',
      segments: [{ start: 0, end: 1, text: 'First' }]
    };
    expect(hasTimestamps(incomplete)).toBe(false);
    expect(JSON.parse(exportJson(incomplete))).toMatchObject({
      text: 'First second',
      segments: []
    });
  });

  it('accepts complete synthetic alignment with or without provider boundary spaces', () => {
    const segments = [
      { start: 0, end: 1, text: 'First' },
      { start: 1, end: 2, text: 'second' }
    ];
    expect(hasTimestamps({ text: ' First\nsecond ', segments })).toBe(true);
    expect(hasTimestamps({ text: 'Firstsecond', segments })).toBe(true);
    expect(hasTimestamps({ text: 'First different', segments })).toBe(false);
  });
});

describe('malformed upload export controls', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['mixed cues', [{ start: 0, end: 1, text: 'First' }, { text: 'second' }]],
    ['null cue', [{ start: 0, end: 1, text: 'First' }, null]],
    ['non-array segments', { start: 0, end: 1, text: 'First' }],
    ['missing cue text', [{ start: 0, end: 1 }]]
  ])('keeps TXT/JSON usable and disables timed downloads for %s', async (_label, segments) => {
    const text = '  First\nsecond  ';
    const downloads: Blob[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ transcript: { text, segments } })
      })
    );
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        downloads.push(blob);
        return 'blob:synthetic-download';
      }),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(createElement(SttApp));
    fireEvent.click(screen.getByRole('tab', { name: 'File Upload' }));
    fireEvent.change(screen.getByLabelText(/Audio and video files accepted/), {
      target: { files: [new File(['fake audio'], 'meeting.mp3', { type: 'audio/mpeg' })] }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe file' }));
    await waitFor(() => expect(screen.getByLabelText('Transcript text')).toHaveValue(text));

    const srt = screen.getByRole('button', { name: 'SRT' });
    const vtt = screen.getByRole('button', { name: 'VTT' });
    expect(srt).toBeDisabled();
    expect(vtt).toBeDisabled();
    fireEvent.click(srt);
    fireEvent.click(vtt);
    expect(downloads).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'TXT' }));
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    expect(downloads).toHaveLength(2);
    const readBlob = (blob: Blob) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsText(blob);
      });
    expect(await readBlob(downloads[0])).toBe(`${text}\n`);
    expect(JSON.parse(await readBlob(downloads[1]))).toMatchObject({ text, segments: [] });
  });
});
