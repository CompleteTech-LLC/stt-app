import { NextRequest, NextResponse } from 'next/server';

import { errorResponseBody, toAppError } from '@/src/lib/errors';
import { logger } from '@/src/lib/logging';
import { realtimeSessionSchema } from '@/src/lib/validation';
import { assertRateLimit, getClientId } from '@/src/server/rateLimit';
import { createRealtimeClientSecret } from '@/src/server/realtime';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    assertRateLimit(request, 'realtime');
    const payload = realtimeSessionSchema.parse(await request.json().catch(() => ({})));

    const session = await createRealtimeClientSecret({
      ...payload,
      safetyIdentifier: getClientId(request)
    });

    logger.info('realtime_session_created', {
      model: session.model,
      language: payload.language,
      expiresAt: session.expiresAt
    });

    return NextResponse.json(session);
  } catch (error) {
    const appError = toAppError(error);
    logger.error('realtime_session_failed', {
      code: appError.code,
      status: appError.status,
      retryable: appError.retryable
    });

    return NextResponse.json(errorResponseBody(appError), { status: appError.status });
  }
}
