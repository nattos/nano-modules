/**
 * Direct OPFS disk tier for GENERATOR-clip thumbnails (#120).
 *
 * One WebP file per thumbnail under `gen-thumbs/`, keyed by the cache's
 * `g<hash>#<sample>` key. Chosen over the video packed-atlas store because that one
 * is tuned for a few large immutable per-source tile sets with a DEBOUNCED index
 * flush — which a page reload races, so most generator tiles were lost across a
 * restart. Here every write is its OWN file that's durably flushed on `close()`, so
 * a reload reads them straight back.
 *
 * Non-blocking: the OPFS API (getFileHandle / createWritable / write / close) is all
 * async, and WebP encode (`OffscreenCanvas.convertToBlob`) + decode (`createImageBitmap`)
 * run off the main thread. Best-effort throughout — any failure degrades to memory-only.
 */

import type { GeneratorThumbPersist } from './generator-thumb-cache';

const ROOT = 'gen-thumbs';

async function rootDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    return await root.getDirectoryHandle(ROOT, { create });
  } catch {
    return null;
  }
}

/** `g<hash>#<sample>` → a flat, filesystem-safe filename. */
function fileName(key: string): string {
  return `${key.replace('#', '_')}.webp`;
}

export const generatorThumbDisk: GeneratorThumbPersist = {
  async write(key: string, bitmap: ImageBitmap): Promise<void> {
    try {
      const dir = await rootDir(true);
      if (!dir) return;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      const fh = await dir.getFileHandle(fileName(key), { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close(); // durable: the bytes are on disk once close resolves
    } catch {
      /* OPFS unavailable / quota → memory-only */
    }
  },

  async read(key: string): Promise<ImageBitmap | null> {
    try {
      const dir = await rootDir(false);
      if (!dir) return null;
      const fh = await dir.getFileHandle(fileName(key)).catch(() => null);
      if (!fh) return null;
      const file = await fh.getFile();
      if (!file.size) return null;
      return await createImageBitmap(file);
    } catch {
      return null;
    }
  },
};
