import { describe, expect, it, vi } from 'vitest';

import { transcribeFile } from '@/src/server/fileTranscription';

describe('OpenAI file transcription integration', () => {
  it('passes audio and transcription options to the OpenAI client', async () => {
    const create = vi.fn().mockResolvedValue({ text: 'Mock transcript.' });
    const client = {
      audio: {
        transcriptions: { create }
      }
    };

    const result = await transcribeFile(
      {
        file: new File(['fake audio'], 'meeting.mp3', { type: 'audio/mpeg' }),
        language: 'en',
        model: 'gpt-4o-mini-transcribe',
        prompt: 'Meeting about Signal STT.'
      },
      client as never
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-mini-transcribe',
        language: 'en',
        prompt: 'Meeting about Signal STT.',
        response_format: 'json'
      })
    );
    expect(result.text).toBe('Mock transcript.');
  });
});
