import { NextResponse } from 'next/server';

import { getServerConfig } from '@/src/lib/config';

export const runtime = 'nodejs';

export function GET() {
  const config = getServerConfig();

  return NextResponse.json({
    ok: true,
    openaiConfigured: config.openaiConfigured,
    models: config.models,
    limits: {
      maxUploadBytes: config.limits.maxUploadBytes
    }
  });
}
