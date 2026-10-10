/** Settings resolution: defaults, clamping and the configuration errors an operator must see. */

import { describe, expect, it } from 'vitest';
import { ConfigurationError, createProvider, resolveSettings } from '../src/config';
import type { Env } from '../src/types';

function envWith(overrides: Partial<Env> = {}): Env {
  return { DB: {} as D1Database, AUDIO: {} as R2Bucket, ...overrides };
}

describe('defaults', () => {
  it('assume Azure in eastus with the Uzbek neural voices', () => {
    const settings = resolveSettings(envWith({ AZURE_SPEECH_KEY: 'key' }));
    expect(settings.providerName).toBe('azure');
    expect(settings.region).toBe('eastus');
    expect(settings.outputFormat).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(settings.allowedVoices).toEqual(['uz-UZ-MadinaNeural', 'uz-UZ-SardorNeural']);
    expect(settings.defaultVoice).toBe('uz-UZ-MadinaNeural');
    expect(settings.maxTranscriptChars).toBe(200_000);
    expect(settings.maxChunkChars).toBe(600);
    expect(settings.maxChunksPerJob).toBe(3_000);
    expect(settings.jobTtlHours).toBe(24);
    expect(settings.chunksPerPass).toBe(8);
    expect(settings.ttsMaxAttempts).toBe(3);
    expect(settings.apiKey).toBeNull();
  });

  it('clamp numbers into their allowed range', () => {
    const settings = resolveSettings(
      envWith({
        AZURE_SPEECH_KEY: 'key',
        CHUNKS_PER_PASS: '999999',
        TTS_CONCURRENCY: '0',
        MAX_CHUNK_CHARS: '5',
        JOB_TTL_HOURS: '99999',
      }),
    );
    expect(settings.chunksPerPass).toBe(200);
    expect(settings.ttsConcurrency).toBe(1);
    expect(settings.maxChunkChars).toBe(50);
    expect(settings.jobTtlHours).toBe(24 * 30);
  });

  it('trim and normalize operator values', () => {
    const settings = resolveSettings(
      envWith({
        AZURE_SPEECH_KEY: 'key',
        API_KEY: '  my-key  ',
        AZURE_SPEECH_REGION: ' EastUS ',
        ALLOWED_VOICES: ' uz-UZ-MadinaNeural , , uz-UZ-SardorNeural ',
        DEFAULT_VOICE: 'uz-UZ-SardorNeural',
      }),
    );
    expect(settings.apiKey).toBe('my-key');
    expect(settings.region).toBe('eastus');
    expect(settings.allowedVoices).toEqual(['uz-UZ-MadinaNeural', 'uz-UZ-SardorNeural']);
    expect(settings.defaultVoice).toBe('uz-UZ-SardorNeural');
  });

  it('treats an empty API key as an open server', () => {
    expect(resolveSettings(envWith({ AZURE_SPEECH_KEY: 'k', API_KEY: '   ' })).apiKey).toBeNull();
  });
});

describe('configuration errors', () => {
  it('rejects an unknown provider', () => {
    expect(() => resolveSettings(envWith({ TTS_PROVIDER: 'google' }))).toThrow(ConfigurationError);
  });

  it('refuses the fake provider unless it was enabled deliberately', () => {
    expect(() => resolveSettings(envWith({ TTS_PROVIDER: 'fake' }))).toThrow(/deliberately/);
    expect(resolveSettings(envWith({ TTS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'true' })).providerName).toBe('fake');
  });

  it('rejects an impossible region, format, voice list or default voice', () => {
    expect(() => resolveSettings(envWith({ AZURE_SPEECH_REGION: 'east us' }))).toThrow(/lowercase/);
    expect(() => resolveSettings(envWith({ AZURE_OUTPUT_FORMAT: 'audio-1' }))).toThrow(/Unsupported/);
    expect(() => resolveSettings(envWith({ ALLOWED_VOICES: ' , ' }))).toThrow(/at least one voice/);
    expect(() =>
      resolveSettings(envWith({ ALLOWED_VOICES: 'uz-UZ-MadinaNeural', DEFAULT_VOICE: 'other' })),
    ).toThrow(/not in ALLOWED_VOICES/);
    expect(() => resolveSettings(envWith({ MAX_CHUNKS_PER_JOB: 'many' }))).toThrow(/whole number/);
  });

  it('reports a missing Azure key when the provider is built', () => {
    const settings = resolveSettings(envWith({ AZURE_SPEECH_KEY: '   ' }));
    expect(() => createProvider(settings, envWith({ AZURE_SPEECH_KEY: '   ' }))).toThrow(/AZURE_SPEECH_KEY/);
  });

  it('builds the fake provider without any cloud credential', () => {
    const env = envWith({ TTS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'true' });
    expect(createProvider(resolveSettings(env), env).name).toBe('fake');
  });
});
