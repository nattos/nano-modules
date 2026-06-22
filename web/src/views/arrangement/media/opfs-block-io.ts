/**
 * OpfsBlockIO — the real disk substrate for the packed thumbnail store, backed
 * by the Origin-Private File System. Each chunk is two files under
 * `thumbs/<sourceHash>/c<N>.pack` (data) and `.idx` (index). Worker-only: it
 * uses `FileSystemSyncAccessHandle` for fast append + ranged reads (sync handles
 * are not available on the main thread).
 *
 * Data handles are opened lazily and kept open (one per active chunk); index
 * files are opened transiently per write (small, infrequent — they're flushed
 * debounced by PackedThumbStore). Implements the same `BlockIO` seam as the
 * in-memory mock, so PackedThumbStore is unchanged.
 */

import type { BlockIO } from './block-io';

// Minimal typings for APIs missing from the ambient lib.
interface SyncAccessHandle {
  read(buffer: ArrayBufferView, opts?: { at?: number }): number;
  write(buffer: ArrayBufferView, opts?: { at?: number }): number;
  getSize(): number;
  truncate(to: number): void;
  flush(): void;
  close(): void;
}

export class OpfsBlockIO implements BlockIO {
  private dataHandles = new Map<string, SyncAccessHandle>();
  private rootDir: FileSystemDirectoryHandle | null = null;

  constructor(private rootName = 'thumbs') {}

  private async root(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootDir) {
      const opfs = await navigator.storage.getDirectory();
      this.rootDir = await opfs.getDirectoryHandle(this.rootName, { create: true });
    }
    return this.rootDir;
  }

  /** Resolve `<chunkKey><ext>` to a file handle, creating dirs as needed. */
  private async fileHandle(chunkKey: string, ext: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const parts = `${chunkKey}${ext}`.split('/');
    let dir = await this.root();
    try {
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create });
      }
      return await dir.getFileHandle(parts[parts.length - 1], { create });
    } catch {
      return null; // missing (and create=false)
    }
  }

  private async dataHandle(chunkKey: string): Promise<SyncAccessHandle> {
    let h = this.dataHandles.get(chunkKey);
    if (!h) {
      const fh = await this.fileHandle(chunkKey, '.pack', true);
      h = await (fh as any).createSyncAccessHandle();
      this.dataHandles.set(chunkKey, h!);
    }
    return h!;
  }

  async appendData(chunkKey: string, bytes: Uint8Array): Promise<number> {
    const h = await this.dataHandle(chunkKey);
    const at = h.getSize();
    h.write(bytes, { at });
    return at;
  }

  async readRange(chunkKey: string, offset: number, len: number): Promise<Uint8Array | null> {
    const h = await this.dataHandle(chunkKey);
    if (offset + len > h.getSize()) return null;
    const buf = new Uint8Array(len);
    h.read(buf, { at: offset });
    return buf;
  }

  async readIndex(chunkKey: string): Promise<ArrayBuffer | null> {
    const fh = await this.fileHandle(chunkKey, '.idx', false);
    if (!fh) return null;
    const file = await fh.getFile();
    if (file.size === 0) return null;
    return file.arrayBuffer();
  }

  async writeIndex(chunkKey: string, buf: ArrayBuffer): Promise<void> {
    const fh = await this.fileHandle(chunkKey, '.idx', true);
    const h: SyncAccessHandle = await (fh as any).createSyncAccessHandle();
    try {
      h.truncate(0);
      h.write(new Uint8Array(buf), { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
  }

  async remove(prefix: string): Promise<void> {
    for (const [k, h] of [...this.dataHandles]) {
      if (k.startsWith(prefix)) { h.close(); this.dataHandles.delete(k); }
    }
    const root = await this.root();
    if (!prefix) {
      for await (const name of (root as any).keys()) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
      }
      return;
    }
    const dirName = prefix.replace(/\/$/, '').split('/')[0];
    await root.removeEntry(dirName, { recursive: true }).catch(() => {});
  }

  totalBytes(): number {
    let t = 0;
    for (const h of this.dataHandles.values()) t += h.getSize();
    return t;
  }

  /** Flush all open data handles (call from the store's flush). */
  flushAll(): void {
    for (const h of this.dataHandles.values()) h.flush();
  }

  /** Close all open data handles (call on reopen / teardown). */
  closeAll(): void {
    for (const h of this.dataHandles.values()) h.close();
    this.dataHandles.clear();
  }
}
