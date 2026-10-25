import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const username = process.env.BASIC_AUTH_USER || '';
const password = process.env.BASIC_AUTH_PASSWORD || '';
const hasControlCharacter = (value) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
if (
  (username || password) &&
  (!username ||
    !password ||
    username.includes(':') ||
    hasControlCharacter(username) ||
    hasControlCharacter(password))
) {
  console.error(
    'Set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD to valid values, or leave both blank.'
  );
  process.exit(1);
}

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
