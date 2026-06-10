import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const apiKey = process.env.OPENAI_API_KEY?.trim();
const models = [
  process.env.OPENAI_FILE_STT_MODEL?.trim() || 'gpt-4o-mini-transcribe',
  process.env.OPENAI_HIGH_ACCURACY_FILE_STT_MODEL?.trim() || 'gpt-4o-transcribe',
  process.env.OPENAI_REALTIME_STT_MODEL?.trim() || 'gpt-realtime-whisper'
];

const uniqueModels = [...new Set(models)];

const readJson = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
};

const classifyOpenAIError = (status, body) => {
  const code = body?.error?.code || body?.error?.type;
  const message = body?.error?.message || body?.raw || `HTTP ${status}`;

  if (status === 401) return { code: code || 'unauthorized', message };
  if (status === 403) return { code: code || 'forbidden', message };
  if (status === 404) return { code: code || 'model_not_found', message };
  if (status === 429) return { code: code || 'rate_or_billing_limit', message };
  if (status >= 500) return { code: code || 'openai_server_error', message };
  return { code: code || 'openai_error', message };
};

if (!apiKey) {
  console.error(
    'OPENAI_API_KEY is missing. Configure it in server-only hosting secrets or .env.local.'
  );
  process.exit(1);
}

if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
  console.error('OPENAI_API_KEY is set but does not look like an OpenAI API key.');
  process.exit(1);
}

let failed = false;

for (const model of uniqueModels) {
  const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  const body = await readJson(response);

  if (response.ok) {
    console.log(`model_access ok model=${model}`);
    continue;
  }

  failed = true;
  const error = classifyOpenAIError(response.status, body);
  console.error(
    `model_access failed model=${model} status=${response.status} code=${error.code} message=${error.message}`
  );
}

if (failed) {
  console.error(
    'OpenAI access verification failed. Check key project, billing, and model allowlists.'
  );
  process.exit(1);
}

console.log('OpenAI model access verification passed for configured STT models.');
