import { NextRequest, NextResponse } from 'next/server';

import { errorResponseBody, toAppError } from '@/src/lib/errors';
import { logger } from '@/src/lib/logging';
import { realtimeSessionSchema } from '@/src/lib/validation';
import { assertRateLimit, getSafetyIdentifier } from '@/src/server/rateLimit';
import { createRealtimeCallAnswer } from '@/src/server/realtime';
import { basicAuthDenial } from '@/src/server/basicAuth';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const denied = basicAuthDenial(request);
  if (denied) return denied;

  try {
    request.signal.throwIfAborted();
    assertRateLimit(request, 'realtime-call');
    const sdp = await request.text();
    request.signal.throwIfAborted();

    if (!sdp.trim().startsWith('v=')) {
      return NextResponse.json(errorResponseBody(toAppError(new Error('Invalid WebRTC offer.'))), {
        status: 400
      });
    }

    const payload = realtimeSessionSchema.parse({
      language: request.nextUrl.searchParams.get('language') || 'en',
      delay: request.nextUrl.searchParams.get('delay') || 'low'
    });

    const answer = await createRealtimeCallAnswer({
      ...payload,
      sdp,
      safetyIdentifier: getSafetyIdentifier(request),
      signal: request.signal
    });
    request.signal.throwIfAborted();

    logger.info('realtime_call_created', {
      model: answer.model,
      language: payload.language
    });

    return new NextResponse(answer.sdp, {
      status: 200,
      headers: {
        'Content-Type': 'application/sdp',
        'X-STT-Model': answer.model
      }
    });
  } catch (error) {
    const appError = toAppError(error, request.signal);
    logger.error('realtime_call_failed', {
      code: appError.code,
      status: appError.status,
      retryable: appError.retryable,
      upstreamStatus: appError.upstreamStatus,
      upstreamCode: appError.upstreamCode
    });

    return NextResponse.json(errorResponseBody(appError), { status: appError.status });
  }
}
