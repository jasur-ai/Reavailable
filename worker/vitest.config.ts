import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside workerd with a local D1 database and R2 bucket, so the SQL and object-storage
 * behaviour exercised here is the real thing. The fake speech provider keeps tests offline and
 * deterministic; Azure request shaping is covered separately with a stubbed fetch.
 *
 * The schema migrations are handed to the tests as a binding and applied with
 * `applyD1Migrations`, the same files `wrangler deploy` applies to the remote database.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations('./migrations');
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TTS_PROVIDER: 'fake',
            ALLOW_FAKE_PROVIDER: 'true',
            ALLOWED_VOICES: 'fake-uz,uz-UZ-MadinaNeural',
            DEFAULT_VOICE: 'fake-uz',
            API_KEY: 'test-api-key',
            AZURE_SPEECH_KEY: 'test-azure-key',
            AZURE_SPEECH_REGION: 'eastus',
            VERSION: 'test',
            CHUNKS_PER_PASS: '50',
            PASS_BUDGET_MS: '60000',
            LEASE_MS: '5000',
            TTS_RETRY_BASE_DELAY_MS: '0',
            TTS_MAX_ATTEMPTS: '3',
            MAX_TRANSCRIPT_CHARS: '200000',
            MAX_CHUNKS_PER_JOB: '2000',
            JOB_TTL_HOURS: '24',
          },
        },
      };
    }),
  ],
});
