import 'server-only';

import { toFile } from 'openai';

import { getServerConfig } from '@/src/lib/config';
import type { FileSttModel } from '@/src/lib/constants';
import type { TranscriptDocument, TranscriptSegment } from '@/src/lib/transcriptExport';
import { createOpenAIClient } from '@/src/server/openaiClient';

type TranscriptionResponse = {
  text?: string;
  segments?: TranscriptSegment[];
  duration?: number;
};

export type FileTranscriptionInput = {
  file: File;
  language: string;
  model: FileSttModel;
  prompt?: string;
};

const normalizeLanguage = (language: string) => (language === 'auto' ? undefined : language);

export const transcribeFile = async (
  input: FileTranscriptionInput,
  client = createOpenAIClient()
): Promise<TranscriptDocument> => {
  const config = getServerConfig();
  const buffer = Buffer.from(await input.file.arrayBuffer());
  const upload = await toFile(buffer, input.file.name, {
    type: input.file.type || 'application/octet-stream'
  });

  const result = (await client.audio.transcriptions.create({
    file: upload,
    model: input.model,
    language: normalizeLanguage(input.language),
    prompt: input.prompt || undefined,
    response_format: 'json'
  })) as TranscriptionResponse;

  return {
    text: result.text?.trim() || '',
    language: input.language,
    model: input.model,
    createdAt: new Date().toISOString(),
    segments: result.segments,
    ...(config.logTranscripts ? { debugTranscriptLength: result.text?.length ?? 0 } : {})
  } as TranscriptDocument;
};
