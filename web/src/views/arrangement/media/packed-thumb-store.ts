/**
 * PackedThumbStore — the real on-disk thumbnail format, behind the
 * `PersistentThumbStore<ArrayBuffer>` seam. Packs many tiles into per-source
 * chunk files (minimal file ops; cloud/scale friendly) over a pluggable
 * `BlockIO` substrate (MemoryBlockIO now; OpfsBlockIO in the worker later).
 *
 * Chunking is by FRAME RANGE only — `chunk = floor(frame / framesPerChunk)` —
 * independent of mip level, so a frame lives in exactly one chunk and its tile
 * is SHARED across every level that snaps to it.
 *
 * Write: append WebP bytes to the chunk data file (append-only = crash-safe),
 * record `frame→{offset,len}` in the chunk's in-memory index, flush the index
 * debounced. Re-writing an existing (source,frame) is a no-op (tiles are
 * immutable for a sourceKey, which embeds size+mtime).
 *
 * Retrieve: parse key → chunk → load that chunk's index once (cached) →
 * readRange(offset,len). Restart = a fresh store over the same BlockIO; indexes
 * reload lazily from disk and tiles return with no re-decode.
 */

import type { PersistentThumbStore } from './thumbnail-store';
import type { BlockIO } from './block-io';
import { encodeIndex, decodeIndex, type ChunkIndex } from './pack-index';
import { parseThumbKey } from './thumbnail-cache';

export interface PackedThumbStoreOpts {
  /** Tiles grouped per chunk file (bounds files-per-source; one ranged-read span). */
  framesPerChunk?: number;
  /** Coalesce index flushes within this window (a scrub burst → one write). */
  flushDebounceMs?: number;
}

/** Filesystem-safe deterministic id for a sourceKey (FNV-1a 32-bit → hex). */
function sourceHash(sourceKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sourceKey.length; i++) {
    h ^= sourceKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class PackedThumbStore implements PersistentThumbStore<ArrayBuffer> {
  private framesPerChunk: number;
  private flushDebounceMs: number;
  /** chunkKey → its loaded index (lazily read from BlockIO once). */
  private indexes = new Map<string, Promise<ChunkIndex>>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private count = 0;

  constructor(private io: BlockIO, opts: PackedThumbStoreOpts = {}) {
    this.framesPerChunk = Math.max(1, opts.framesPerChunk ?? 256);
    this.flushDebounceMs = opts.flushDebounceMs ?? 400;
  }

  private chunkKey(sourceKey: string, frame: number): string {
    return `${sourceHash(sourceKey)}/c${Math.floor(frame / this.framesPerChunk)}`;
  }

  private indexFor(chunkKey: string): Promise<ChunkIndex> {
    let p = this.indexes.get(chunkKey);
    if (!p) {
      p = this.io.readIndex(chunkKey).then((buf) => (buf ? decodeIndex(buf) : new Map()));
      this.indexes.set(chunkKey, p);
    }
    return p;
  }

  async read(key: string): Promise<ArrayBuffer | null> {
    const { sourceKey, frame } = parseThumbKey(key);
    const ck = this.chunkKey(sourceKey, frame);
    const loc = (await this.indexFor(ck)).get(frame);
    if (!loc) return null;
    const bytes = await this.io.readRange(ck, loc.offset, loc.len);
    if (!bytes) return null;
    // Return an exact, standalone ArrayBuffer (handles any byteOffset).
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async readMany(keys: string[]): Promise<Array<ArrayBuffer | null>> {
    // Groups naturally by chunk via the per-chunk index cache; a real OPFS
    // backend can additionally fuse intra-chunk ranges into one read.
    return Promise.all(keys.map((k) => this.read(k)));
  }

  async write(key: string, value: ArrayBuffer): Promise<void> {
    const { sourceKey, frame } = parseThumbKey(key);
    const ck = this.chunkKey(sourceKey, frame);
    const idx = await this.indexFor(ck);
    if (idx.has(frame)) return; // immutable tile — already persisted
    const bytes = new Uint8Array(value);
    const offset = await this.io.appendData(ck, bytes);
    idx.set(frame, { offset, len: bytes.byteLength });
    this.count++;
    this.dirty.add(ck);
    this.scheduleFlush();
  }

  async has(key: string): Promise<boolean> {
    const { sourceKey, frame } = parseThumbKey(key);
    return (await this.indexFor(this.chunkKey(sourceKey, frame))).has(frame);
  }

  async clear(prefix?: string): Promise<void> {
    await this.flush();
    if (!prefix) {
      await this.io.remove('');
      this.indexes.clear();
      this.count = 0;
      return;
    }
    const ph = `${sourceHash(prefix)}/`;
    await this.io.remove(ph);
    for (const k of [...this.indexes.keys()]) if (k.startsWith(ph)) this.indexes.delete(k);
  }

  size(): number {
    return this.count;
  }

  // ── Index flush ──────────────────────────────────────────────────────────

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDebounceMs);
  }

  /** Persist all dirty chunk indexes now (call on visibilitychange/unload). */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const ck of dirty) {
      const idx = await this.indexFor(ck);
      await this.io.writeIndex(ck, encodeIndex(idx));
    }
  }
}
