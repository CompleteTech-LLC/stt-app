const target = process.env.STT_APP_URL || 'http://127.0.0.1:3000';
const sampleRate = 16_000;
const seconds = 1;
const samples = sampleRate * seconds;
const dataSize = samples * 2;
const buffer = Buffer.alloc(44 + dataSize);

buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 2, 28);
buffer.writeUInt16LE(2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

const form = new FormData();
form.set(
  'file',
  new File([buffer], 'stt-smoke-silence.wav', {
    type: 'audio/wav'
  })
);
form.set('language', 'en');
form.set('model', process.env.OPENAI_FILE_STT_MODEL || 'gpt-4o-mini-transcribe');

const response = await fetch(`${target.replace(/\/$/, '')}/api/transcribe`, {
  method: 'POST',
  body: form
});

const body = await response.json().catch(() => ({}));

if (!response.ok) {
  const error = body.error || {};
  console.error(
    `upload_smoke failed status=${response.status} code=${error.code || 'unknown'} upstreamStatus=${
      error.upstreamStatus || ''
    } upstreamCode=${error.upstreamCode || ''} message=${error.message || 'Unknown error'}`
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    hasTranscript: Boolean(body.transcript),
    textLength: body.transcript?.text?.length ?? 0,
    model: body.transcript?.model,
    language: body.transcript?.language,
    segments: Array.isArray(body.transcript?.segments) ? body.transcript.segments.length : null
  })
);
