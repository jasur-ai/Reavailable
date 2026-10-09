import {
  ApiClient,
  ApiError,
  NetworkError,
  normalizeBaseUrl,
  type FetchLike,
  type RequestInitLike,
  type ResponseLike,
} from '../../src/core/api/client';

interface Call {
  url: string;
  init: RequestInitLike;
}

const SHA = 'b'.repeat(64);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function recordingFetch(handler: (call: Call) => Promise<ResponseLike> | ResponseLike): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

/** A body that never finishes until the request is aborted, like a stalled mobile connection. */
function stalledBody(signal: AbortSignal | undefined): ResponseLike {
  const never = new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => never,
    arrayBuffer: () => never,
  };
}

function clientWith(fetch: FetchLike, extra: { apiKey?: string; timeoutMs?: number } = {}): ApiClient {
  return new ApiClient({ baseUrl: 'http://server.test:8000/', fetch, timeoutMs: 40, ...extra });
}

describe('normalizeBaseUrl', () => {
  it('trims spaces and trailing slashes', () => {
    expect(normalizeBaseUrl('  http://192.168.1.20:8000/// ')).toBe('http://192.168.1.20:8000');
  });

  it('keeps a path prefix used by a reverse proxy', () => {
    expect(normalizeBaseUrl('https://example.org/audiobooks/')).toBe('https://example.org/audiobooks');
  });

  it.each(['', 'not a url', 'ftp://server', 'http://server?x=1', 'https://server/#top'])(
    'rejects %p',
    (value) => {
      expect(() => normalizeBaseUrl(value)).toThrow();
    },
  );
});

describe('ApiClient: requests', () => {
  it('calls the versioned API without authentication for health', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { status: 'ok', version: '1.0.0' }));
    const result = await clientWith(fetch).health();

    expect(result).toEqual({ status: 'ok', version: '1.0.0' });
    expect(calls[0].url).toBe('http://server.test:8000/api/v1/health');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it('sends the transcript, the chunk size and the optional voice when creating a job', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(202, {
        id: 'job-1',
        status: 'queued',
        title: 'Book',
        voice: 'uz-UZ-MadinaNeural',
        total_chunks: 0,
        warnings: [],
        expires_at: '2026-10-10T00:00:00Z',
        access_token: 'secret',
      }),
    );
    const client = clientWith(fetch, { apiKey: 'key-123' });
    const created = await client.createJob({ title: 'Book', transcript: 'Salom.', sentencesPerChunk: 2 });

    expect(created.access_token).toBe('secret');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['X-API-Key']).toBe('key-123');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body ?? '{}')).toEqual({
      title: 'Book',
      transcript: 'Salom.',
      sentences_per_chunk: 2,
    });

    await client.createJob({ title: 'Book', transcript: 'Salom.', sentencesPerChunk: 1, voice: 'uz-UZ-SardorNeural' });
    expect(JSON.parse(calls[1].init.body ?? '{}')).toMatchObject({ voice: 'uz-UZ-SardorNeural' });
  });

  it('sends no API key header when none is configured', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(202, { id: 'j', status: 'queued', access_token: 't', title: '', voice: '', total_chunks: 0 }),
    );
    await clientWith(fetch).createJob({ title: 'x', transcript: 'y', sentencesPerChunk: 1 });
    expect(calls[0].init.headers['X-API-Key']).toBeUndefined();
  });

  it('sends the job token as a bearer header on job requests', async () => {
    const { fetch, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/retry')) {
        return jsonResponse(202, { id: 'job-1', status: 'queued' });
      }
      if (call.url.endsWith('/ack')) {
        return jsonResponse(200, { acknowledged: [0], remaining: 0, job_deleted: true });
      }
      if (call.init.method === 'DELETE') {
        return { ok: true, status: 204, headers: { get: () => null }, json: async () => undefined, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return jsonResponse(200, { id: 'job-1', status: 'ready' });
    });
    const client = clientWith(fetch);
    await client.getJob('job-1', 'tok');
    await client.retryJob('job-1', 'tok');
    await client.acknowledge('job-1', 'tok', [{ index: 0, sha256: SHA }]);
    await client.deleteJob('job-1', 'tok');

    for (const call of calls) {
      expect(call.init.headers.Authorization).toBe('Bearer tok');
    }
  });

  it('acknowledges only index and checksum', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { acknowledged: [2], remaining: 1, job_deleted: false }));
    const result = await clientWith(fetch).acknowledge('job-1', 'tok', [{ index: 2, sha256: SHA }]);

    expect(result).toEqual({ acknowledged: [2], remaining: 1, job_deleted: false });
    expect(JSON.parse(calls[0].init.body ?? '{}')).toEqual({ chunks: [{ index: 2, sha256: SHA }] });
  });

  it('downloads chunk bytes with the checksum header and asks for audio', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    const { fetch, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'X-Content-SHA256' ? SHA : name === 'Content-Type' ? 'audio/mpeg' : null) },
      json: async () => undefined,
      arrayBuffer: async () => payload,
    }));
    const chunk = await clientWith(fetch).downloadChunk('job-1', 'tok', 3);

    expect(calls[0].url).toBe('http://server.test:8000/api/v1/jobs/job-1/chunks/3');
    expect(calls[0].init.headers.Accept).toBe('audio/*');
    expect(Array.from(chunk.bytes)).toEqual([1, 2, 3, 4]);
    expect(chunk.sha256Header).toBe(SHA);
    expect(chunk.contentType).toBe('audio/mpeg');
  });

  it('deletes a job and accepts an empty 204 body', async () => {
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('empty');
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(clientWith(fetch).deleteJob('job-1', 'tok')).resolves.toBeUndefined();
  });
});

describe('ApiClient: server errors', () => {
  it('turns the server error body into an ApiError with its code', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(404, { error: { code: 'job_not_found', message: 'No such job.' } }),
    );
    const error = await clientWith(fetch)
      .getJob('job-1', 'tok')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'job_not_found', message: 'No such job.' });
  });

  it('uses a generic code when the error body is not JSON', async () => {
    const { fetch } = recordingFetch(() => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('html');
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(clientWith(fetch).health()).rejects.toMatchObject({ status: 500, code: 'http_500' });
  });

  it('reports a successful answer that is not JSON as an invalid response', async () => {
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('html');
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(clientWith(fetch).health()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
  });

  it('rejects a job status without an identifier', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(200, { status: 'ready' }));
    await expect(clientWith(fetch).getJob('job-1', 'tok')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a manifest entry whose checksum is not a SHA-256 hex string', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(200, {
        job_id: 'job-1',
        title: 'Book',
        total_chunks: 1,
        chunks: [{ index: 0, sha256: 'not-a-hash', size_bytes: 10, content_type: 'audio/mpeg', char_count: 0, url: '' }],
      }),
    );
    await expect(clientWith(fetch).getManifest('job-1', 'tok')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts a well-formed manifest', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(200, {
        job_id: 'job-1',
        title: 'Book',
        total_chunks: 1,
        chunks: [{ index: 0, sha256: SHA, size_bytes: 10, content_type: 'audio/mpeg', char_count: 6, url: '/x' }],
      }),
    );
    const manifest = await clientWith(fetch).getManifest('job-1', 'tok');
    expect(manifest.chunks[0].sha256).toBe(SHA);
  });
});

describe('ApiClient: network failures and timeouts', () => {
  it('reports an unreachable server as a network error', async () => {
    const { fetch } = recordingFetch(() => {
      throw new TypeError('Network request failed');
    });
    const error = await clientWith(fetch).health().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ timedOut: false });
    expect((error as Error).message).toContain('Network request failed');
  });

  it('times out when the server does not answer in time', async () => {
    const { fetch } = recordingFetch((call) => new Promise<ResponseLike>((_, reject) => {
      call.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const error = await clientWith(fetch).health().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ timedOut: true });
  });

  it('times out when the body of a chunk stalls after the headers arrived', async () => {
    const { fetch } = recordingFetch((call) => stalledBody(call.init.signal));
    const error = await clientWith(fetch).downloadChunk('job-1', 'tok', 0).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ timedOut: true });
  });

  it('reports a connection that drops while the body is read', async () => {
    const { fetch } = recordingFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
      arrayBuffer: async () => {
        throw new TypeError('socket closed');
      },
    }));
    const error = await clientWith(fetch).downloadChunk('job-1', 'tok', 0).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).timedOut).toBe(false);
    expect((error as Error).message).toContain('interrupted');
  });
});
