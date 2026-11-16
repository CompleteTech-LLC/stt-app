import 'server-only';

import { toFile } from 'openai';

import { getServerConfig } from '@/src/lib/config';
import type { FileSttModel } from '@/src/lib/constants';
import { alignedTranscriptSegments, type TranscriptDocument } from '@/src/lib/transcriptExport';
import { createOpenAIClient } from '@/src/server/openaiClient';

type TranscriptionResponse = {
  text?: unknown;
  segments?: unknown;
};

export type FileTranscriptionInput = {
  file: File;
  language: string;
  model: FileSttModel;
  prompt?: string;
  signal?: AbortSignal;
};

const normalizeLanguage = (language: string) => (language === 'auto' ? undefined : language);

export const transcribeFile = async (
  input: FileTranscriptionInput,
  client?: ReturnType<typeof createOpenAIClient>
): Promise<TranscriptDocument> => {
  input.signal?.throwIfAborted();
  const openai = client ?? createOpenAIClient();
  const config = getServerConfig();
  const buffer = Buffer.from(await input.file.arrayBuffer());
  input.signal?.throwIfAborted();
  const upload = await toFile(buffer, input.file.name, {
    type: input.file.type || 'application/octet-stream'
  });
  input.signal?.throwIfAborted();

  const result: unknown = await openai.audio.transcriptions.create(
    {
      file: upload,
      model: input.model,
      language: normalizeLanguage(input.language),
      prompt: input.prompt || undefined,
      response_format: 'json'
    },
    input.signal ? { signal: input.signal } : undefined
  );
  input.signal?.throwIfAborted();
  const response: TranscriptionResponse =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as TranscriptionResponse)
      : {};
  const text = typeof response.text === 'string' ? response.text : '';

  return {
    text,
    language: input.language,
    model: input.model,
    createdAt: new Date().toISOString(),
    segments: alignedTranscriptSegments(text, response.segments) ?? [],
    ...(config.logTranscripts ? { debugTranscriptLength: text.length } : {})
  } as TranscriptDocument;
};
