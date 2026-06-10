import { z } from 'zod';

import {
  acceptedExtensions,
  acceptedMimeTypes,
  appLimits,
  isFileSttModel,
  sttModels
} from './constants';
import { AppError } from './errors';

export const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(auto|[a-z]{2,3}(-[a-z0-9]{2,8})?)$/, 'Use a valid language hint.')
  .default('en');

export const transcribeFormSchema = z.object({
  language: languageSchema,
  model: z
    .string()
    .trim()
    .refine(isFileSttModel, 'Unsupported transcription model.')
    .default(sttModels.fileDefault),
  prompt: z.string().trim().max(500, 'Prompt must be 500 characters or less.').optional()
});

export const realtimeSessionSchema = z.object({
  language: languageSchema,
  delay: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('low')
});

export const validateRequestSize = (
  contentLength: string | null,
  maxBytes = appLimits.maxUploadBytes
) => {
  if (!contentLength) return;
  const bytes = Number.parseInt(contentLength, 10);
  if (Number.isFinite(bytes) && bytes > maxBytes) {
    throw new AppError(
      'INVALID_FILE',
      `Upload is too large. Maximum size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
      413
    );
  }
};

const hasAcceptedExtension = (filename: string) =>
  acceptedExtensions.some((extension) => filename.toLowerCase().endsWith(extension));

export const validateUploadFile = (
  file: File,
  maxBytes = appLimits.maxUploadBytes
): { name: string; type: string; size: number } => {
  if (!file || file.size === 0) {
    throw new AppError('INVALID_FILE', 'Choose a non-empty audio or video file.', 400);
  }

  if (file.size > maxBytes) {
    throw new AppError(
      'INVALID_FILE',
      `File is too large. Maximum size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
      413
    );
  }

  const type = file.type || 'application/octet-stream';
  const extensionOk = hasAcceptedExtension(file.name);
  const mimeOk = acceptedMimeTypes.includes(type as (typeof acceptedMimeTypes)[number]);

  if (!mimeOk && !extensionOk) {
    throw new AppError(
      'INVALID_FILE',
      'Unsupported file type. Upload a common audio or video file.',
      415
    );
  }

  return { name: file.name, type, size: file.size };
};
