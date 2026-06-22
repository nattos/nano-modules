/**
 * WorkerThumbStore — main-thread proxy to the thumbnail worker, implementing
 * `PersistentThumbStore<ImageBitmap>`. Drops straight into ThumbnailManager with
 * an identity codec (the real WebP codec + OPFS live in the worker).
 *
 *   read(key)        → worker decodes from OPFS, transfers an ImageBitmap back.
 *   write(key, bmp)  → CLONE the bitmap (so the memory tier keeps its copy) and
 *                      transfer the clone to the worker to encode + persist.
 */

import type { PersistentThumbStore } from './thumbnail-store';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export class WorkerThumbStore implements PersistentThumbStore<ImageBitmap> {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private _size = 0;

  constructor(worker?: Worker) {
    this.worker =
      worker ??
      new Worker(new URL('./thumbnail-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(e.data);
    };
  }

  private rpc(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async read(key: string): Promise<ImageBitmap | null> {
    const r = await this.rpc({ op: 'get', key });
    return r.bitmap ?? null;
  }

  async readMany(keys: string[]): Promise<Array<ImageBitmap | null>> {
    return Promise.all(keys.map((k) => this.read(k)));
  }

  async write(key: string, bitmap: ImageBitmap): Promise<void> {
    // Clone so the caller's (memory-tier) bitmap isn't consumed by the transfer.
    const clone = await createImageBitmap(bitmap);
    await this.rpc({ op: 'put', key, bitmap: clone }, [clone]);
    this._size++;
  }

  async has(key: string): Promise<boolean> {
    return (await this.rpc({ op: 'has', key })).has;
  }

  async clear(prefix?: string): Promise<void> {
    await this.rpc({ op: 'clear', prefix });
    if (!prefix) this._size = 0;
  }

  size(): number {
    return this._size;
  }

  /** Persist pending indexes + flush data handles. */
  async flush(): Promise<void> {
    await this.rpc({ op: 'flush' });
  }

  /** Models a restart: worker drops in-memory state and re-opens OPFS. */
  async reopen(): Promise<void> {
    await this.rpc({ op: 'reopen' });
  }

  async stats(): Promise<{ size: number; bytes: number }> {
    return (await this.rpc({ op: 'stats' })).stats;
  }

  destroy(): void {
    this.worker.terminate();
  }
}
