import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const key = process.env.OPENAI_API_KEY;

if (!key) {
  console.error(
    'OPENAI_API_KEY is missing. Configure it in server-only hosting secrets or .env.local.'
  );
  process.exit(1);
}

if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) {
  console.error('OPENAI_API_KEY is set but does not look like an OpenAI API key.');
  process.exit(1);
}

console.log('Environment validation passed. OPENAI_API_KEY is present.');
