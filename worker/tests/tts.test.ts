/** Azure request shaping and error classification, plus the offline fake provider. */

import { describe, expect, it } from 'vitest';
import { AZURE_FORMATS, TtsError, buildSsml, createAzureProvider, createFakeProvider } from '../src/tts';

function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const options = {
  key: 'test-key',
  region: 'eastus',
  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
  allowedVoices: ['uz-UZ-MadinaNeural', 'uz-UZ-SardorNeural'],
};

describe('SSML', () => {
  it('wraps the text in an Uzbek speak element with the chosen voice', () => {
    expect(buildSsml('Salom dunyo', 'uz-UZ-MadinaNeural')).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="uz-UZ">' +
        '<voice name="uz-UZ-MadinaNeural">Salom dunyo</voice></speak>',
    );
  });

  it('escapes markup characters in text and voice', () => {
    const ssml = buildSsml('a & b < c > d " e \' f', 'voice"&');
    expect(ssml).toContain('a &amp; b &lt; c &gt; d &quot; e &apos; f');
    expect(ssml).toContain('<voice name="voice&quot;&amp;">');
  });

  it('drops characters that are invalid in XML', () => {
    expect(buildSsml(`a\u0000b\u0007c`, 'uz-UZ-MadinaNeural')).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="uz-UZ">' +
        '<voice name="uz-UZ-MadinaNeural">abc</voice></speak>',
    );
  });
});

describe('Azure provider', () => {
  it('posts SSML to the regional endpoint with the subscription key', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const azure = createAzureProvider({ ...options, fetchImpl });

    const result = await azure.synthesize('Salom', 'uz-UZ-MadinaNeural');
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.extension).toBe('mp3');
    expect([...result.audio]).toEqual([1, 2, 3]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('test-key');
    expect(headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(headers['Content-Type']).toBe('application/ssml+xml');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toContain('<voice name="uz-UZ-MadinaNeural">Salom</voice>');
  });

  it('knows the content type of every supported format', () => {
    expect(AZURE_FORMATS['riff-24khz-16bit-mono-pcm']).toEqual({ contentType: 'audio/wav', extension: 'wav' });
    expect(AZURE_FORMATS['ogg-24khz-16bit-mono-opus']).toEqual({ contentType: 'audio/ogg', extension: 'ogg' });
  });

  it('refuses a voice that is not allowed', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const azure = createAzureProvider({ ...options, fetchImpl });
    await expect(azure.synthesize('Salom', 'en-US-JennyNeural')).rejects.toMatchObject({
      code: 'tts_bad_request',
      transient: false,
    });
    expect(calls).toHaveLength(0);
  });

  const cases: [number, string, boolean][] = [
    [401, 'tts_auth_failed', false],
    [403, 'tts_auth_failed', false],
    [429, 'tts_unavailable', true],
    [500, 'tts_unavailable', true],
    [503, 'tts_unavailable', true],
    [400, 'tts_bad_request', false],
    [404, 'tts_bad_request', false],
  ];

  it.each(cases)('maps HTTP %i to %s (transient=%s)', async (status, code, transient) => {
    const { fetchImpl } = stubFetch(() => new Response('nope', { status }));
    const azure = createAzureProvider({ ...options, fetchImpl });
    const error = await azure.synthesize('Salom', 'uz-UZ-MadinaNeural').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TtsError);
    expect(error).toMatchObject({ code, transient });
  });

  it('treats empty audio as transient', async () => {
    const { fetchImpl } = stubFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    const azure = createAzureProvider({ ...options, fetchImpl });
    await expect(azure.synthesize('Salom', 'uz-UZ-MadinaNeural')).rejects.toMatchObject({
      code: 'tts_unavailable',
      transient: true,
    });
  });

  it('treats a network failure as transient and never leaks the key', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error('socket hang up');
    });
    const azure = createAzureProvider({ ...options, fetchImpl });
    const error = (await azure
      .synthesize('Salom', 'uz-UZ-MadinaNeural')
      .catch((caught: unknown) => caught)) as TtsError;
    expect(error).toMatchObject({ code: 'tts_unavailable', transient: true });
    expect(error.message).not.toContain('test-key');
  });

  it('rejects an impossible configuration', () => {
    expect(() => createAzureProvider({ ...options, region: 'East US' })).toThrow(/lowercase/);
    expect(() => createAzureProvider({ ...options, outputFormat: 'audio-99' })).toThrow(/Unsupported/);
    expect(() => createAzureProvider({ ...options, allowedVoices: [] })).toThrow(/At least one voice/);
    expect(() => createAzureProvider({ ...options, key: '' })).toThrow(/key is required/);
  });
});

describe('fake provider', () => {
  it('renders a WAV whose length follows the text length', async () => {
    const fake = createFakeProvider();
    const result = await fake.synthesize('a'.repeat(150), 'fake-uz');
    expect(result.contentType).toBe('audio/wav');
    expect(result.extension).toBe('wav');
    const view = new DataView(result.audio.buffer, result.audio.byteOffset, result.audio.byteLength);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000);
    // 150 characters at 15 characters per second is 10 seconds of audio.
    expect(view.getUint32(40, true)).toBe(16_000 * 10 * 2);
  });

  it('clamps the length and refuses unusable input', async () => {
    const fake = createFakeProvider();
    const short = await fake.synthesize('hi', 'fake-uz');
    expect(short.audio.byteLength).toBe(44 + 16_000 * 2 * 0.25);
    await expect(fake.synthesize('   ', 'fake-uz')).rejects.toMatchObject({ code: 'tts_bad_request' });
    await expect(fake.synthesize('salom', 'uz-UZ-MadinaNeural')).rejects.toMatchObject({ code: 'tts_bad_request' });
    expect(fake.allowedVoices).toEqual(['fake-uz']);
  });
});
