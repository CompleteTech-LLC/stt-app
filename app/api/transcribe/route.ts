import { NextRequest, NextResponse } from 'next/server';

import { sttModels } from '@/src/lib/constants';
import { AppError, errorResponseBody, toAppError } from '@/src/lib/errors';
import { logger } from '@/src/lib/logging';
import {
  transcribeFormSchema,
  validateRequestSize,
  validateUploadFile
} from '@/src/lib/validation';
import { assertRateLimit } from '@/src/server/rateLimit';
import { transcribeFile } from '@/src/server/fileTranscription';
import { getServerConfig } from '@/src/lib/config';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const config = getServerConfig();
    assertRateLimit(request, 'transcribe');
    validateRequestSize(request.headers.get('content-length'), config.limits.maxUploadBytes);

    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json(
        errorResponseBody(new AppError('INVALID_FILE', 'No file uploaded.', 400)),
        {
          status: 400
        }
      );
    }

    const metadata = validateUploadFile(file, config.limits.maxUploadBytes);
    const fields = transcribeFormSchema.parse({
      language: form.get('language')?.toString() || 'en',
      model: form.get('model')?.toString() || sttModels.fileDefault,
      prompt: form.get('prompt')?.toString() || undefined
    });

    logger.info('transcription_started', {
      size: metadata.size,
      type: metadata.type,
      model: fields.model,
      language: fields.language
    });

    const transcript = await transcribeFile({
      file,
      language: fields.language,
      model: fields.model,
      prompt: fields.prompt
    });

    logger.info('transcription_completed', {
      size: metadata.size,
      type: metadata.type,
      model: fields.model,
      language: fields.language,
      transcriptLength: transcript.text.length
    });

    return NextResponse.json({ transcript });
  } catch (error) {
    const appError = toAppError(error);
    logger.error('transcription_failed', {
      code: appError.code,
      status: appError.status,
      retryable: appError.retryable
    });

    return NextResponse.json(errorResponseBody(appError), { status: appError.status });
  }
}
