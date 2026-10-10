/**
 * Speech synthesis providers.
 *
 * `azure` is the real provider: Azure AI Speech (neural TTS) over REST with SSML, the same request
 * the Python backend sends. `fake` renders a quiet tone so the pipeline can be exercised without
 * cloud credentials; it must be enabled explicitly and never produces speech.
 *
 * Errors are classified as transient (retry) or permanent (fail the job), with codes that match the
 * Python backend: `tts_auth_failed`, `tts_bad_request`, `tts_unavailable`.
 */

export type TtsErrorCode = 'tts_auth_failed' | 'tts_bad_request' | 'tts_unavailable';

export class TtsError extends Error {
  readonly code: TtsErrorCode;
  readonly transient: boolean;

  constructor(code: TtsErrorCode, message: string, transient: boolean) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.transient = transient;
  }
}

export interface SynthesisResult {
  audio: Uint8Array;
  contentType: string;
  extension: string;
}

export interface TtsProvider {
  readonly name: string;
  readonly allowedVoices: readonly string[];
  synthesize(text: string, voice: string): Promise<SynthesisResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_SSML_LANGUAGE = 'uz-UZ';
const USER_AGENT = 'reavailable-worker/0.2';
const INVALID_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const REGION_PATTERN = /^[a-z0-9]+$/;

export const AZURE_FORMATS: Readonly<Record<string, { contentType: string; extension: string }>> = {
  'audio-24khz-48kbitrate-mono-mp3': { contentType: 'audio/mpeg', extension: 'mp3' },
  'audio-16khz-32kbitrate-mono-mp3': { contentType: 'audio/mpeg', extension: 'mp3' },
  'ogg-24khz-16bit-mono-opus': { contentType: 'audio/ogg', extension: 'ogg' },
  'riff-24khz-16bit-mono-pcm': { contentType: 'audio/wav', extension: 'wav' },
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Azure voice names start with their locale, for example `en-US-JennyNeural` -> `en-US`. */
export function languageOfVoice(voice: string): string {
  const match = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice);
  return match ? match[1] : DEFAULT_SSML_LANGUAGE;
}

/** Build an SSML document for one voice. Text and attribute values are XML-escaped. */
export function buildSsml(text: string, voice: string): string {
  const safeText = text.replace(INVALID_XML_CHARS, '');
  const language = languageOfVoice(voice);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}">` +
    `<voice name="${escapeXml(voice)}">${escapeXml(safeText)}</voice>` +
    '</speak>'
  );
}

export interface AzureProviderOptions {
  key: string;
  region: string;
  outputFormat: string;
  allowedVoices: readonly string[];
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/** Azure AI Speech over REST. Mirrors `backend/app/tts/azure.py`. */
export function createAzureProvider(options: AzureProviderOptions): TtsProvider {
  const { key, region, outputFormat, allowedVoices } = options;
  if (!REGION_PATTERN.test(region)) {
    throw new Error("Azure region must be lowercase letters and digits, for example 'eastus'");
  }
  const format = AZURE_FORMATS[outputFormat];
  if (!format) {
    throw new Error(`Unsupported Azure output format: ${outputFormat}`);
  }
  if (allowedVoices.length === 0) {
    throw new Error('At least one voice is required');
  }
  if (!key) {
    throw new Error('An Azure speech key is required');
  }
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    name: 'azure',
    allowedVoices,
    async synthesize(text: string, voice: string): Promise<SynthesisResult> {
      if (!allowedVoices.includes(voice)) {
        throw new TtsError('tts_bad_request', 'Voice is not allowed.', false);
      }
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'X-Microsoft-OutputFormat': outputFormat,
            'Content-Type': 'application/ssml+xml',
            'User-Agent': USER_AGENT,
          },
          body: buildSsml(text, voice),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        throw new TtsError('tts_unavailable', `Speech request failed (${message}).`, true);
      }

      const status = response.status;
      if (status === 401 || status === 403) {
        throw new TtsError('tts_auth_failed', 'Speech provider rejected the credentials.', false);
      }
      if (status === 429 || status >= 500) {
        throw new TtsError('tts_unavailable', `Speech provider returned HTTP ${status}.`, true);
      }
      if (status !== 200) {
        throw new TtsError('tts_bad_request', `Speech provider returned HTTP ${status}.`, false);
      }
      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.byteLength === 0) {
        throw new TtsError('tts_unavailable', 'Speech provider returned empty audio.', true);
      }
      return { audio, contentType: format.contentType, extension: format.extension };
    },
  };
}

const SAMPLE_RATE = 16_000;
const TONE_HZ = 220;
const AMPLITUDE = 2_000;
const CHARS_PER_SECOND = 15;
const MIN_SECONDS = 0.25;
const MAX_SECONDS = 60;

/** Render a mono 16-bit PCM WAV, the same shape `backend/app/tts/fake.py` produces. */
function renderWav(seconds: number): Uint8Array {
  const count = Math.floor(seconds * SAMPLE_RATE);
  const dataBytes = count * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < count; index += 1) {
    const sample = Math.round(AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE));
    view.setInt16(44 + index * 2, sample, true);
  }
  return new Uint8Array(buffer);
}

/** Offline provider for tests and local runs. Produces a tone, never speech. */
export function createFakeProvider(): TtsProvider {
  return {
    name: 'fake',
    allowedVoices: ['fake-uz'],
    async synthesize(text: string, voice: string): Promise<SynthesisResult> {
      if (voice !== 'fake-uz') {
        throw new TtsError('tts_bad_request', 'Voice is not allowed.', false);
      }
      if (!text.trim()) {
        throw new TtsError('tts_bad_request', 'Text is empty.', false);
      }
      const seconds = Math.min(Math.max(text.length / CHARS_PER_SECOND, MIN_SECONDS), MAX_SECONDS);
      return { audio: renderWav(seconds), contentType: 'audio/wav', extension: 'wav' };
    },
  };
}
