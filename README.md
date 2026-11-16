<p align="center"><img src="assets/banner.jpg" alt="A microphone and audio waveform flowing into a transcript document, a file upload tray and a shielded secure server, in teal and amber on midnight navy." width="100%"></p>

# Signal STT

Secure full-stack speech-to-text app built with Next.js, React, TypeScript, and server-side OpenAI API calls. It is for developers who want a small, self-hosted transcription UI (live microphone or file upload) that keeps the OpenAI API key on the server.

Status: early prototype (version 0.1.0, not published as a package). It needs your own OpenAI API key and a project with access to the configured transcription models. To try it, see [Setup](#setup).

## Overview

- Live Mic mode sends the browser's WebRTC SDP offer to the app's own server route, which exchanges it with the OpenAI Realtime API, and shows partial/final transcript updates.
- File Upload mode validates common audio/video files and transcribes them through a server-only API route.
- Transcript workspace supports editing, copy, clear, TXT/JSON export, and SRT/VTT export when timestamp segments exist.
- No persistent storage is used by default. Uploads are handled in memory and are not written to disk.

### Transcript exports

TXT and JSON export the text currently shown in the workspace, including live drafts and edits,
when its order is established. SRT and VTT require valid original timestamps for every segment.
Editing the text or adding live speech invalidates that alignment, so subtitle exports are disabled
and JSON exports an empty `segments` list. The configured file models use JSON transcription and
do not promise timestamp segments; synthetic timestamp fixtures are not evidence of provider
availability. Realtime events do not supply segment timestamps. Starting live capture alone does
not relabel an existing upload. Combined text uses `model: "mixed"` when its sources differ, and
omits the language when the sources do not share a known language.

Live transcription uses the documented transcription `item_id` to associate deltas, final
transcripts and failures. An `event_id` identifies an event, not an utterance. Predecessor IDs
order overlapping items as direct predecessor chains. An explicit null predecessor marks the first
item; an item with an unknown predecessor is provisional and is not irreversibly committed. Late
metadata can reorder provisional items. While their order is unconfirmed the preview is provisional
and Copy/TXT/JSON are disabled. Stop retains available text, marking each unresolved item
`[Live item; order unconfirmed]` so the exported sequence does not claim to be chronological.
Editing a provisional preview fences that session, so late metadata cannot repair the edited text.
Any nonempty edit made while provisional text is present remains unexportable until you explicitly
confirm its displayed order or keep it with an `[Edited live text; order unconfirmed]` label. Stop
also applies that label, even if the edit currently has no text. Use **Clear** or successfully
replace the workspace with an upload to discard the uncertain edit; erasing the textarea alone does
not resolve it. The label leaves the edited text and its whitespace intact.
Editing text that already contains an uncertainty label also requires an explicit choice again,
so removing the label in an ordinary edit cannot silently turn unconfirmed order into fact.
Contradictory or duplicate first-item metadata, conflicting terminal events, and conflicting
audio/non-audio identities fence the session. A failed predecessor is terminal: available partial
text is retained, successors can continue, and the workspace shows a warning.

Realtime turn detection is disabled for the configured model. Press **Finish turn** after speaking
to send an explicit `input_audio_buffer.commit`; listening continues. Each commit has a distinct
client event ID. A new, identified server acknowledgement releases the pending turn; an error does
so only when its nested client event ID matches that turn. The server acknowledgement does not echo
the client ID, so this assumes the one outstanding commit receives its acknowledgement before the
next commit. An acknowledgement without a server event ID cannot safely release a turn: Stop and
retry, or wait for an identified acknowledgement. Wait for transcription and ordering metadata
before pressing Stop. Stop releases capture immediately and does not wait for a commit or final
response; any available unresolved text is retained with the labels described above. If the active
data channel closes, capture stops and Retry is available; uncommitted audio and pending results may
be lost, and audio already sent cannot be retracted. No recording is uploaded or turn committed
automatically. No periodic commits are sent. These controls have synthetic coverage only, not live
provider or browser-media qualification.

Clearing, editing, or replacing the workspace during a live session fences **all subsequent events
from that session**, including events for unknown predecessors. Missing or conflicting item IDs,
malformed tracked events, unexpected transcript fields, contradictory ordering, or resource limits
also pause acceptance of further events rather than guessing their identity or order. A visible
message asks you to Stop and Start a new session; the microphone is not automatically stopped by
this realtime transcript fence. If microphone permission or realtime setup is still pending, a
workspace edit, clear, or successful replacement upload instead retires that setup and stops any
acquired capture; that session cannot later start fallback recording. During local fallback
recording, the same actions stop capture and discard the recording before upload, so it will not be
transcribed. If fallback transcription is already in flight, cancellation is best effort: the result
is discarded, but audio already sent cannot be retracted and may already have been transcribed.
A successful fallback transcription appends to existing text and any
retained live draft instead of replacing them. Retry while fallback recording discards that recording
and reports the disposition. If a recorder stops unexpectedly, capture is released immediately and
its audio stays in this tab until you choose **Transcribe recording** or **Discard recording**; it
is not uploaded automatically. If recording reports an error, only chunks already received are
retained for this choice and they may be incomplete. An older upload cannot replace a later edit,
clear, new upload, or live session. Text in rejected events is not captured and may need to be
repeated in the new session.

For one session, the tracker retains at most 1,024 item IDs (including referenced predecessors),
4,096 event IDs, and 1,000,000 UTF-16 code units each of pending transcript text, resolved item
text, and serialized event payloads retained for deduplication. Each item or event ID is limited to
256 code units. A data-channel message over 1,100,000 code units is also refused before JSON parsing.
Reaching a limit fences the session instead of evicting IDs that could still be needed to reject
late events. Registration, transcription delta/completion/failure, and error events share the same
server event-ID space. Exact repeated payloads with the same nonempty `event_id` are suppressed
before ordering or turn state changes; conflicting or malformed IDs fence the session. Payloads are
retained only in bounded browser-session memory, not displayed or logged, and released when the
tracker finishes or the workspace changes. Omitted or null event IDs are treated as unidentified:
registration metadata can still establish order, but an unidentified acknowledgement cannot
release a pending turn. Without an event ID, a repeated delta is indistinguishable from legitimate
repeated text and is appended; a final transcript replaces the item's accumulated draft. These
rules have synthetic test coverage, not live provider qualification.

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

The username cannot contain a colon, and neither value may contain control characters. The UTF-8 encoded `username:password` pair is limited to 6,144 bytes.

Every page and API request is protected except the exact `/api/health` endpoint, which remains available to health probes. Both paid API routes also validate credentials themselves before reading uploads or contacting OpenAI. Authenticated mutations reject cross-site browser requests and opaque or foreign origins. Origin checks compare the full scheme, host, and port. Set `BASIC_AUTH_PUBLIC_ORIGIN` to the exact browser-facing origin, such as `http://127.0.0.1:3000` locally or `https://stt.example.com` behind TLS termination, without a trailing slash. When authentication is enabled, missing or malformed values cause all protected requests to return HTTP 503; production startup validation also rejects them. The check never derives the canonical origin from Host, forwarding headers, or the internally reconstructed request URL. Configure the public ingress and backend access appropriately for your deployment. Credentialed scripts without an `Origin` header remain supported. An incomplete or invalid configuration returns HTTP 503 instead of allowing access; production startup validation also rejects it. Leave both variables empty to disable authentication.

The authentication browser suite exercises real local HTTP with a configured origin and a second server with the origin unset. It does not exercise TLS termination: a synthetic local HTTPS proxy could test scheme handling with a locally trusted test certificate and a configured HTTPS origin, but would not validate a production ingress, certificate chain, header sanitization, or backend isolation. Validate those separately in the target deployment.

This is one shared account, without individual users, sessions, or a logout button. Anyone sharing the credentials shares the same rate-limit bucket and safety identifier, regardless of IP. A per-user identity provider or authenticating reverse proxy remains appropriate for multi-user deployments. Scripts calling the paid APIs must also supply the configured Basic credentials.

The application does not rate-limit failed authentication attempts. Use a strong, unique password and an upstream access control or brute-force protection where needed.

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

Production auth HTTP test plan: build with synthetic environment values, then run the built server directly with `next start` to bypass the startup validator. On an isolated loopback port, check that missing and malformed public origins return 503 for authenticated and unauthenticated page requests and both paid POST routes, with and without Origin, while `/api/health` remains available. Restart with a valid public origin and check the 401 challenge, authenticated page access, cross-site 403, and an originless authenticated POST with an invalid body (400). Use only synthetic credentials and invalid request bodies so no provider request is made. Separately run `npm run validate:env` through the synthetic subprocess tests to cover startup validation.
