<p align="center"><img src="assets/banner.jpg" alt="A microphone and audio waveform flowing into a transcript document, a file upload tray and a shielded secure server, in teal and amber on midnight navy." width="100%"></p>

# Signal STT

Secure full-stack speech-to-text app built with Next.js, React, TypeScript, and server-side OpenAI API calls. It is for developers who want a small, self-hosted transcription UI (live microphone or file upload) that keeps the OpenAI API key on the server.

Status: early prototype (version 0.1.0, not published as a package). It needs your own OpenAI API key and a project with access to the configured transcription models. To try it, see [Setup](#setup).

## Overview

- Live Mic mode sends the browser's WebRTC SDP offer to the app's own server route, which exchanges it with the OpenAI Realtime API, and shows partial/final transcript updates.
- File Upload mode validates common audio/video files and transcribes them through a server-only API route.
- Transcript workspace supports editing, copy, clear, TXT/JSON export, and SRT/VTT export when timestamp segments exist.
- No persistent storage is used by default. Uploads are handled in memory and are not written to disk.

## Architecture

- `app/api/transcribe/route.ts`: multipart upload API, size checks, rate limiting, server-side transcription.
- `app/api/realtime/call/route.ts`: exchanges the browser's WebRTC SDP offer with OpenAI server-side; the raw OpenAI API key and no provider tokens ever reach the browser.
- `src/lib/constants.ts`: centralized model names, MIME types, extensions, and limits.
- `src/lib/config.ts`: server-only environment loading and startup/runtime validation helpers.
- `src/server/fileTranscription.ts`: OpenAI Audio Transcriptions API wrapper.
- `src/server/realtime.ts`: Realtime transcription call (SDP exchange) wrapper.
- `src/server/rateLimit.ts`: in-memory rate limiter, client identification, and hashed safety identifiers.
- `proxy.ts` and `src/server/basicAuth.ts`: optional shared HTTP Basic authentication for pages and API routes.
- `src/lib/transcriptExport.ts`: TXT, JSON, SRT, and VTT export helpers.
- `components/stt-app.tsx`: Live Mic, File Upload, and transcript workspace UI.

## Secure Key Setup

Create a project-scoped OpenAI Platform API key (this repo uses the name `production-stt-app` in examples) through your approved organization secret workflow, then install it as a server-only secret:

1. Create the key in the OpenAI Platform API key settings for the intended project.
2. Store it as `OPENAI_API_KEY` in your deployment secret store.
3. For local development only, place it in `.env.local`.
4. Do not commit `.env.local`; it is ignored by `.gitignore`.

The app never prints, logs, or exposes the raw key. `npm run validate:env` checks that `OPENAI_API_KEY` is present and key-shaped, and that optional Basic authentication is configured completely. `npm run verify:openai` checks whether the configured project can see the configured STT models.

## Setup

```bash
npm install
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY through a secure local editor
npm run dev
```

Open `http://localhost:3000`.

## Commands

```bash
npm run dev
npm run build
npm start
npm run validate:env
npm run verify:openai
npm run smoke:upload
npm run lint
npm run format
npm run typecheck
npm run test
npm run test:e2e
npm run quality
```

## Models And Limits

Defaults are centralized in `src/lib/constants.ts` and can be overridden through environment variables:

- Live STT: `gpt-realtime-whisper`
- File STT default: `gpt-4o-mini-transcribe`
- File STT higher accuracy: `gpt-4o-transcribe`
- Upload limit: 25 MB by default

## Privacy And Security

- Audio is sent to OpenAI for transcription.
- Audio and transcripts are not stored by this app by default.
- OpenAI calls run server-side. The browser sends WebRTC SDP offers to the server, and the server exchanges them with OpenAI.
- Logs exclude raw audio, full transcripts, tokens, keys, and secrets.
- The API includes request size checks, MIME/extension validation, rate limiting, timeouts, structured errors, and a healthcheck.
- Docker builds exclude local `.env*` files through `.dockerignore`; pass secrets only at runtime.
- Authentication is **off by default**. Anyone who can reach an unprotected app can spend your OpenAI quota. Enable the optional Basic authentication below or put it behind an authenticating reverse proxy, VPN, or similar access control before exposing it.

### Optional shared Basic authentication

Set both `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` as server-only environment variables. Browsers prompt for these credentials before opening the app and reuse them for same-origin API requests. Use a strong password and HTTPS outside local development: Basic authentication encodes credentials but does not encrypt them. Never put these values in `NEXT_PUBLIC_*` variables.

Every page and API request is protected except the exact `/api/health` endpoint, which remains available to health probes. Both paid API routes also validate credentials themselves before reading uploads or contacting OpenAI. Authenticated mutations reject cross-site browser requests and opaque or foreign origins. Reverse proxies must preserve the public `Host` header for same-origin browser requests to pass this check; client-supplied forwarding headers are not trusted. Credentialed scripts without an `Origin` header remain supported. An incomplete or invalid configuration returns HTTP 503 instead of allowing access; production startup validation also rejects it. Leave both variables empty to disable authentication.

This is one shared account, without individual users, sessions, or a logout button. Anyone sharing the credentials shares the same rate-limit bucket and safety identifier, regardless of IP. A per-user identity provider or authenticating reverse proxy remains appropriate for multi-user deployments. Scripts calling the paid APIs must also supply the configured Basic credentials.

### Rate limiting and proxies

The built-in rate limiter is in-memory and per process. Authenticated requests are keyed by their verified Basic username. Without Basic authentication, Next.js route handlers do not expose the socket address, and `X-Forwarded-For` / `X-Real-IP` can be forged by any client, so by default these headers are ignored and **all callers share one rate-limit bucket** (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS` in total).

If the app runs behind a reverse proxy you control that sets `X-Forwarded-For` (appending the real client address) or `X-Real-IP`, set `TRUST_PROXY=true`. The limiter then keys buckets on the right-most `X-Forwarded-For` entry (the one your proxy added), falling back to `X-Real-IP`. Only enable this when the app is not directly reachable by clients, otherwise they can forge the header.

### Safety identifier

With Basic authentication, realtime requests send OpenAI an `OpenAI-Safety-Identifier` header containing a salted SHA-256 hash of the verified username. Otherwise, when `TRUST_PROXY=true`, the identifier hashes the client address. Neither the raw username nor IP is sent upstream. Set `SAFETY_IDENTIFIER_SALT` to a long random secret to keep identifiers stable across restarts; otherwise a random per-process salt is used. Without authentication or `TRUST_PROXY` the header is omitted.

## Deployment

### Generic Node Hosting

1. Build with `npm ci && npm run build`.
2. Set `OPENAI_API_KEY` in the host secret manager.
3. Run `npm run verify:openai && npm start`; `npm start` validates `OPENAI_API_KEY` before serving.
4. Ensure the host supports outbound HTTPS to OpenAI.

### Vercel-Style Hosting

1. Add `OPENAI_API_KEY` as a server-side environment variable.
2. Keep the key out of `NEXT_PUBLIC_*` variables.
3. Deploy normally with the Next.js adapter.
4. Confirm `/api/health` returns `openaiConfigured: true`.

Realtime WebRTC requires browser microphone permission and network access to `https://api.openai.com`.

## Troubleshooting

- Missing key: API routes return a structured `MISSING_API_KEY` error and production startup validation fails safely.
- Key present but transcription fails: run `npm run verify:openai`. A key can be present while the project still lacks active billing, model allowlist access, or permission to use the configured STT models.
- Upload route smoke test: with the dev or production server running, run `npm run smoke:upload`. It sends a tiny generated WAV through `/api/transcribe` and reports sanitized status/error metadata.
- Unsupported file: check file type, extension, and size.
- Realtime fails before connecting: check that the OpenAI project has active billing and access to `gpt-realtime-whisper`. Local recording fallback is used only for browser/network microphone failures, not server-side OpenAI access failures.
- OpenAI HTTP 500 during realtime setup: confirm the project has active billing and access to the configured realtime transcription model. A configured key is not enough if the project is not active for paid API usage.
- Long files: shorten or compress the file, then retry.
- Upstream failures: retry later or switch file mode to `gpt-4o-transcribe` for accuracy-sensitive jobs.

## License

Code and documentation are released under the [MIT License](LICENSE).
