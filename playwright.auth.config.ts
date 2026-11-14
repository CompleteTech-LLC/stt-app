import { defineConfig, devices } from '@playwright/test';

// Dedicated server: never reuse a developer's server or its credentials.
export default defineConfig({
  testDir: './tests/auth-e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3108', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3108',
    url: 'http://127.0.0.1:3108/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      BASIC_AUTH_USER: 'synthetic-user',
      BASIC_AUTH_PASSWORD: 'synthetic-password',
      BASIC_AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:3108',
      OPENAI_API_KEY: '',
      TRUST_PROXY: 'false'
    }
  }
});
