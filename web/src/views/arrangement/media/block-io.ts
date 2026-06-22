/**
 * BlockIO — the thin substrate seam under the packed thumbnail store.
 *
 * This is the ONLY piece the real backend implements: append bytes to a chunk's
 * data file, read a byte range, and read/write a chunk's index blob. Everything
 * above it (packing, chunking, index format) is pure and substrate-independent.
 *
 *   - MemoryBlockIO  — in-memory mock (dev + headless tests; disk stays mocked).
 *   - OpfsBlockIO    — (future) backs each chunk with two OPFS files
 *                      (`<chunkKey>.pack` data, `<chunkKey>.idx` index), using a
 *                      FileSystemSyncAccessHandle inside the thumbnail worker for
 *                      fast appends + ranged reads.
 */

export interface BlockIO {
  /** Append `bytes` to the chunk's data file; resolves to the start offset. */
  appendData(chunkKey: string, bytes: Uint8Array): Promise<number>;
  /** Read `len` bytes at `offset` from the chunk's data file (null if absent). */
  readRange(chunkKey: string, offset: number, len: number): Promise<Uint8Array | null>;
  /** Read the chunk's serialized index (null if it has none yet). */
  readIndex(chunkKey: string): Promise<ArrayBuffer | null>;
  /** Replace the chunk's serialized index. */
  writeIndex(chunkKey: string, buf: ArrayBuffer): Promise<void>;
  /** Delete every chunk (data + index) whose key starts with `prefix`. */
  remove(prefix: string): Promise<void>;
  /** Total resident data bytes (for the budget / eviction policy). */
  totalBytes(): number;
}

/** In-memory BlockIO — the mocked disk tier. Models append + ranged read. */
export class MemoryBlockIO implements BlockIO {
  private data = new Map<string, Uint8Array>();
  private index = new Map<string, ArrayBuffer>();
  reads = 0;
  writes = 0;

  async appendData(chunkKey: string, bytes: Uint8Array): Promise<number> {
    const prev = this.data.get(chunkKey);
    const offset = prev ? prev.byteLength : 0;
    const next = new Uint8Array(offset + bytes.byteLength);
    if (prev) next.set(prev, 0);
    next.set(bytes, offset);
    this.data.set(chunkKey, next);
    this.writes++;
    return offset;
  }

  async readRange(chunkKey: string, offset: number, len: number): Promise<Uint8Array | null> {
    const buf = this.data.get(chunkKey);
    if (!buf || offset + len > buf.byteLength) return null;
    this.reads++;
    return buf.slice(offset, offset + len);
  }

  async readIndex(chunkKey: string): Promise<ArrayBuffer | null> {
    return this.index.get(chunkKey) ?? null;
  }

  async writeIndex(chunkKey: string, buf: ArrayBuffer): Promise<void> {
    this.index.set(chunkKey, buf);
  }

  async remove(prefix: string): Promise<void> {
    for (const k of [...this.data.keys()]) if (k.startsWith(prefix)) this.data.delete(k);
    for (const k of [...this.index.keys()]) if (k.startsWith(prefix)) this.index.delete(k);
  }

  totalBytes(): number {
    let t = 0;
    for (const b of this.data.values()) t += b.byteLength;
    return t;
  }
}
