// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = resolve('scripts/validate-env.mjs');
const validKey = `sk-${'x'.repeat(24)}`;
const credentials = {
  BASIC_AUTH_USER: 'synthetic-user',
  BASIC_AUTH_PASSWORD: 'synthetic-password'
};

const validate = (values: Record<string, string | undefined>) => {
  // A separate cwd prevents developer .env files from affecting the subprocess.
  const cwd = mkdtempSync(join(tmpdir(), 'validate-env-'));
  try {
    return spawnSync(process.execPath, [script], {
      cwd,
      env: { PATH: process.env.PATH, OPENAI_API_KEY: validKey, ...values, NODE_ENV: 'test' },
      encoding: 'utf8'
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

describe('startup environment validation', () => {
  it.each([{}, { BASIC_AUTH_PUBLIC_ORIGIN: 'invalid' }])('allows disabled auth: %j', (env) => {
    expect(validate(env).status).toBe(0);
  });

  it.each([
    { BASIC_AUTH_USER: 'synthetic-user' },
    { BASIC_AUTH_PASSWORD: 'synthetic-password' },
    { ...credentials, BASIC_AUTH_USER: 'invalid:user' },
    { ...credentials, BASIC_AUTH_PASSWORD: 'invalid\npassword' }
  ])('rejects partial or invalid credentials: %j', (env) => {
    const result = validate(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BASIC_AUTH_USER');
  });

  it.each([
    '',
    'null',
    'https://example.com/path',
    'https://user@example.com',
    'https://example.com/'
  ])('rejects invalid public origin %j', (origin) => {
    const result = validate({ ...credentials, BASIC_AUTH_PUBLIC_ORIGIN: origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BASIC_AUTH_PUBLIC_ORIGIN');
  });

  it.each(['http://localhost:3000', 'https://example.com'])(
    'accepts valid enabled auth at %s',
    (origin) => {
      expect(validate({ ...credentials, BASIC_AUTH_PUBLIC_ORIGIN: origin }).status).toBe(0);
    }
  );
});
