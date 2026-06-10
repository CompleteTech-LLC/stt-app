# Signal STT

Secure full-stack speech-to-text app built with Next.js, React, TypeScript, and server-side OpenAI API calls.

## Overview

- Live Mic mode creates a server-side OpenAI Realtime client secret, connects the browser to the Realtime API with WebRTC, and shows partial/final transcript updates.
- File Upload mode validates common audio/video files and transcribes them through a server-only API route.
- Transcript workspace supports editing, copy, clear, TXT/JSON export, and SRT/VTT export when timestamp segments exist.
- No persistent storage is used by default. Uploads are handled in memory and are not written to disk.

## Architecture

- `app/api/transcribe/route.ts`: multipart upload API, size checks, rate limiting, server-side transcription.
- `app/api/realtime/session/route.ts`: creates short-lived realtime client secrets; the raw OpenAI API key never reaches the browser.
- `src/lib/constants.ts`: centralized model names, MIME types, extensions, and limits.
- `src/lib/config.ts`: server-only environment loading and startup/runtime validation helpers.
- `src/server/fileTranscription.ts`: OpenAI Audio Transcriptions API wrapper.
- `src/server/realtime.ts`: Realtime transcription session-secret wrapper.
- `src/lib/transcriptExport.ts`: TXT, JSON, SRT, and VTT export helpers.
- `components/stt-app.tsx`: Live Mic, File Upload, and transcript workspace UI.

## Secure Key Setup

An approved Codex/OpenAI API-key creation tool was not available in this session. Create a project-scoped OpenAI Platform key named `production-stt-app` manually or through your approved organization secret workflow, then install it as a server-only secret:

1. Create the key in the OpenAI Platform API key settings for the intended project.
2. Store it as `OPENAI_API_KEY` in your deployment secret store.
3. For local development only, place it in `.env.local`.
4. Do not commit `.env.local`; it is ignored by `.gitignore`.

The app never prints, logs, or exposes the raw key. `npm run validate:env` checks only that `OPENAI_API_KEY` is present and key-shaped.

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

## Deployment

### Generic Node Hosting

1. Build with `npm ci && npm run build`.
2. Set `OPENAI_API_KEY` in the host secret manager.
3. Run `npm run validate:env && npm start`.
4. Ensure the host supports outbound HTTPS to OpenAI.

### Vercel-Style Hosting

1. Add `OPENAI_API_KEY` as a server-side environment variable.
2. Keep the key out of `NEXT_PUBLIC_*` variables.
3. Deploy normally with the Next.js adapter.
4. Confirm `/api/health` returns `openaiConfigured: true`.

Realtime WebRTC requires browser microphone permission and network access to `https://api.openai.com`.

## Troubleshooting

- Missing key: API routes return a structured `MISSING_API_KEY` error and production startup validation fails safely.
- Unsupported file: check file type, extension, and size.
- Realtime fails before connecting: check that the OpenAI project has active billing and access to `gpt-realtime-whisper`. Local recording fallback is used only for browser/network microphone failures, not server-side OpenAI access failures.
- OpenAI HTTP 500 during realtime setup: confirm the project has active billing and access to the configured realtime transcription model. A configured key is not enough if the project is not active for paid API usage.
- Long files: shorten or compress the file, then retry.
- Upstream failures: retry later or switch file mode to `gpt-4o-transcribe` for accuracy-sensitive jobs.
