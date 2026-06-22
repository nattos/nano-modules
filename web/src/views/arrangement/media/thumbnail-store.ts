/**
 * PersistentThumbStore — the warm (disk) tier of the thumbnail cache.
 *
 * Survives app restarts and avoids re-decoding (the startup problem), and is the
 * landing place for thumbnails decoded once from a slow-seek / cloud source. The
 * store holds a SERIALIZED form `S` (not the live `ImageBitmap`) so the hot
 * tier can freely close bitmaps on eviction without corrupting persisted data —
 * `ThumbCodec` converts between the live value `V` and the stored `S`.
 *
 * Persistence to actual disk is MOCKED for now (`MockThumbStore` = async Map
 * with optional latency to model slow/cloud I/O). Real-disk strategy, punted:
 *   - Back with OPFS (or a real workspace dir) keyed `${sourceKey}/${frame}`.
 *   - Encode `S` as WebP/JPEG bytes (small, fast to decode).
 *   - Pack many tiles into per-(source,level) ATLAS files and use `readMany` to
 *     pull a whole strip in one I/O — critical for cloud/high-latency stores.
 *   - Maintain an on-disk index + size budget; evict cold sources LRU.
 * The async, batch-friendly API here is shaped so that swap is non-breaking.
 */

/** Converts between the live thumbnail `V` (e.g. ImageBitmap) and stored `S`. */
export interface ThumbCodec<V, S> {
  encode(value: V): Promise<S>;
  decode(serialized: S): Promise<V>;
}

/** Identity codec — for tests / when V is already serializable. */
export function identityCodec<V>(): ThumbCodec<V, V> {
  return {
    async encode(v) { return v; },
    async decode(s) { return s; },
  };
}

export interface PersistentThumbStore<S> {
  read(key: string): Promise<S | null>;
  /** Batch read (returns null per missing key) — one I/O for a whole strip. */
  readMany(keys: string[]): Promise<Array<S | null>>;
  write(key: string, value: S): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Clear everything, or only keys beginning with `prefix` (e.g. a sourceKey). */
  clear(prefix?: string): Promise<void>;
  /** Resident entry count (debug / budget). */
  size(): number;
}

export interface MockThumbStoreOpts {
  /** Artificial per-op latency (ms) to model slow-seek / cloud storage. */
  latencyMs?: number;
}

/** In-memory stand-in for the disk tier, with an async, latency-modeling API. */
export class MockThumbStore<S> implements PersistentThumbStore<S> {
  private map = new Map<string, S>();
  private latency: number;
  reads = 0;
  writes = 0;

  constructor(opts: MockThumbStoreOpts = {}) {
    this.latency = opts.latencyMs ?? 0;
  }

  private delay(): Promise<void> {
    return this.latency > 0
      ? new Promise((r) => setTimeout(r, this.latency))
      : Promise.resolve();
  }

  async read(key: string): Promise<S | null> {
    await this.delay();
    this.reads++;
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  async readMany(keys: string[]): Promise<Array<S | null>> {
    await this.delay();
    this.reads += keys.length;
    return keys.map((k) => (this.map.has(k) ? this.map.get(k)! : null));
  }

  async write(key: string, value: S): Promise<void> {
    await this.delay();
    this.writes++;
    this.map.set(key, value);
  }

  async has(key: string): Promise<boolean> {
    await this.delay();
    return this.map.has(key);
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.map.clear();
      return;
    }
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  size(): number {
    return this.map.size;
  }
}
