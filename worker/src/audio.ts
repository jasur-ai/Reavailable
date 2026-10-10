/**
 * Audio part storage on Workers KV.
 *
 * The service only needs four operations (get, put, delete, list) with the same shape R2 offers, so
 * this adapter lets the rest of the code stay unchanged. KV is used instead of R2 because it is free
 * on the Workers free plan and can be created with an API token, while R2 must be enabled by hand in
 * the dashboard. Values are capped at 25 MiB by KV; one synthesized part is far smaller.
 */

export interface AudioObject {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface AudioListResult {
  objects: { key: string; size: number }[];
  truncated: boolean;
  cursor?: string;
}

export class KvAudioStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<AudioObject | null> {
    const { value, metadata } = await this.kv.getWithMetadata<{ contentType?: string; size?: number }>(key, 'arrayBuffer');
    if (value === null) {
      return null;
    }
    return {
      body: new Response(value).body as ReadableStream,
      size: metadata?.size ?? value.byteLength,
      httpMetadata: metadata?.contentType ? { contentType: metadata.contentType } : undefined,
    };
  }

  async put(key: string, data: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const size = data.byteLength;
    await this.kv.put(key, data, {
      metadata: { contentType: options?.httpMetadata?.contentType, size },
    });
  }

  /** Deletes one key or a list of keys. */
  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    await Promise.all(list.map((key) => this.kv.delete(key)));
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<AudioListResult> {
    const result = await this.kv.list<{ size?: number }>({
      prefix: options.prefix || undefined,
      cursor: options.cursor,
      limit: options.limit,
    });
    return {
      objects: result.keys.map((entry) => ({ key: entry.name, size: entry.metadata?.size ?? 0 })),
      truncated: !result.list_complete,
      cursor: result.list_complete ? undefined : result.cursor,
    };
  }
}
