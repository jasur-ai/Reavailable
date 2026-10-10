/**
 * Runtime settings resolved from the Worker environment.
 *
 * Numbers arrive as strings from `wrangler.toml` and are clamped to sane ranges. A missing Azure
 * key is reported as a configuration error at request time (Workers have no start-up phase), which
 * the API turns into HTTP 503 `server_misconfigured`.
 */

import { createAzureProvider, createFakeProvider, AZURE_FORMATS, type TtsProvider } from './tts';
import type { Env } from './types';

/** Two voices (female and male) per language. Labels in the app are generic, never names. */
export const DEFAULT_VOICES = [
  'uz-UZ-MadinaNeural',
  'uz-UZ-SardorNeural',
  'en-US-JennyNeural',
  'en-US-GuyNeural',
] as const;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface Settings {
  version: string;
  /** Shared key required on job creation, or null when creation is open. */
  apiKey: string | null;
  region: string;
  outputFormat: string;
  allowedVoices: string[];
  defaultVoice: string;
  maxRequestBytes: number;
  maxTranscriptChars: number;
  maxChunkChars: number;
  maxChunksPerJob: number;
  jobTtlHours: number;
  chunksPerPass: number;
  ttsConcurrency: number;
  ttsMaxAttempts: number;
  ttsRetryBaseDelayMs: number;
  ttsTimeoutMs: number;
  passBudgetMs: number;
  leaseMs: number;
  providerName: 'azure' | 'fake';
}

function intFrom(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new ConfigurationError(`Setting is not a whole number: ${raw}`);
  }
  return Math.min(Math.max(parsed, min), max);
}

function truthy(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export function resolveSettings(env: Env): Settings {
  const providerName = (env.TTS_PROVIDER ?? 'azure').trim().toLowerCase();
  if (providerName !== 'azure' && providerName !== 'fake') {
    throw new ConfigurationError(`TTS_PROVIDER must be 'azure' or 'fake', got '${providerName}'`);
  }
  if (providerName === 'fake' && !truthy(env.ALLOW_FAKE_PROVIDER)) {
    throw new ConfigurationError(
      "The fake provider only renders a tone. Set ALLOW_FAKE_PROVIDER='true' to use it deliberately.",
    );
  }

  const outputFormat = env.AZURE_OUTPUT_FORMAT ?? 'audio-24khz-48kbitrate-mono-mp3';
  if (!(outputFormat in AZURE_FORMATS)) {
    throw new ConfigurationError(`Unsupported AZURE_OUTPUT_FORMAT: ${outputFormat}`);
  }

  const region = (env.AZURE_SPEECH_REGION ?? 'eastus').trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(region)) {
    throw new ConfigurationError("AZURE_SPEECH_REGION must be lowercase letters and digits, for example 'eastus'");
  }

  const allowedVoices = (env.ALLOWED_VOICES ?? DEFAULT_VOICES.join(','))
    .split(',')
    .map((voice) => voice.trim())
    .filter((voice) => voice.length > 0);
  if (allowedVoices.length === 0) {
    throw new ConfigurationError('ALLOWED_VOICES must list at least one voice');
  }
  const defaultVoice = env.DEFAULT_VOICE?.trim() || allowedVoices[0];
  if (!allowedVoices.includes(defaultVoice)) {
    throw new ConfigurationError(`DEFAULT_VOICE '${defaultVoice}' is not in ALLOWED_VOICES`);
  }

  const apiKey = env.API_KEY?.trim() ? env.API_KEY.trim() : null;

  return {
    version: env.VERSION ?? '0.2.0',
    apiKey,
    region,
    outputFormat,
    allowedVoices,
    defaultVoice,
    maxRequestBytes: intFrom(env.MAX_REQUEST_BYTES, 2_000_000, 1_024, 20_000_000),
    maxTranscriptChars: intFrom(env.MAX_TRANSCRIPT_CHARS, 200_000, 1, 2_000_000),
    maxChunkChars: intFrom(env.MAX_CHUNK_CHARS, 600, 50, 3_000),
    maxChunksPerJob: intFrom(env.MAX_CHUNKS_PER_JOB, 6_000, 1, 20_000),
    jobTtlHours: intFrom(env.JOB_TTL_HOURS, 24, 1, 24 * 30),
    chunksPerPass: intFrom(env.CHUNKS_PER_PASS, 8, 1, 200),
    ttsConcurrency: intFrom(env.TTS_CONCURRENCY, 3, 1, 10),
    ttsMaxAttempts: intFrom(env.TTS_MAX_ATTEMPTS, 3, 1, 10),
    ttsRetryBaseDelayMs: intFrom(env.TTS_RETRY_BASE_DELAY_MS, 1_000, 0, 30_000),
    ttsTimeoutMs: intFrom(env.TTS_TIMEOUT_MS, 30_000, 1_000, 120_000),
    passBudgetMs: intFrom(env.PASS_BUDGET_MS, 20_000, 1_000, 120_000),
    leaseMs: intFrom(env.LEASE_MS, 30_000, 5_000, 300_000),
    providerName,
  };
}

export interface ProviderOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Build the speech provider described by the settings. */
export function createProvider(settings: Settings, env: Env, options: ProviderOptions = {}): TtsProvider {
  if (settings.providerName === 'fake') {
    return createFakeProvider();
  }
  const key = env.AZURE_SPEECH_KEY?.trim();
  if (!key) {
    throw new ConfigurationError('AZURE_SPEECH_KEY is not set.');
  }
  return createAzureProvider({
    key,
    region: settings.region,
    outputFormat: settings.outputFormat,
    allowedVoices: settings.allowedVoices,
    timeoutMs: settings.ttsTimeoutMs,
    fetchImpl: options.fetchImpl,
  });
}
