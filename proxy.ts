import { NextRequest, NextResponse } from 'next/server';

import { basicAuthDenial, getBasicAuthConfig } from '@/src/server/basicAuth';

export function proxy(request: NextRequest) {
  // Keep only the exact health endpoint available to unauthenticated probes.
  if (request.nextUrl.pathname === '/api/health') return NextResponse.next();
  const response = basicAuthDenial(request) ?? NextResponse.next();
  if (getBasicAuthConfig().mode !== 'disabled') {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Vary', 'Authorization');
  }
  return response;
}
