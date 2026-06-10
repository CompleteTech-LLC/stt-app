import { describe, expect, it } from 'vitest';

import { AppError } from '@/src/lib/errors';
import {
  transcribeFormSchema,
  validateRequestSize,
  validateUploadFile
} from '@/src/lib/validation';

describe('upload validation', () => {
  it('accepts common audio files', () => {
    const file = new File(['audio'], 'meeting.mp3', { type: 'audio/mpeg' });

    expect(validateUploadFile(file)).toEqual({
      name: 'meeting.mp3',
      type: 'audio/mpeg',
      size: 5
    });
  });

  it('rejects unsupported files', () => {
    const file = new File(['not audio'], 'notes.txt', { type: 'text/plain' });

    expect(() => validateUploadFile(file)).toThrow(AppError);
  });

  it('rejects oversized request bodies before parsing', () => {
    expect(() => validateRequestSize('2048', 1024)).toThrow('Upload is too large');
  });

  it('validates model and language fields', () => {
    expect(
      transcribeFormSchema.parse({
        language: 'EN',
        model: 'gpt-4o-mini-transcribe',
        prompt: 'Names: Ada'
      })
    ).toEqual({
      language: 'en',
      model: 'gpt-4o-mini-transcribe',
      prompt: 'Names: Ada'
    });

    expect(() => transcribeFormSchema.parse({ language: 'english', model: 'bad-model' })).toThrow();
  });
});
