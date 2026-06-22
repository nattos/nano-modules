/**
 * Thumbnail worker — owns the OPFS substrate + the packed format + the WebP
 * codec, so all disk I/O and tile encode/decode run off the main thread. The
 * main thread talks to it via `WorkerThumbStore` (postMessage + transferred
 * ImageBitmaps).
 *
 * Message protocol: { id, op, key?, bitmap?, prefix? } → reply { id, ... } or
 * { id, error }. `get` replies with a transferred ImageBitmap (or null).
 */

import { OpfsBlockIO } from './opfs-block-io';
import { PackedThumbStore } from './packed-thumb-store';
import { webpEncode, webpDecode } from './webp-codec';

let io = new OpfsBlockIO('thumbs');
let store = new PackedThumbStore(io, { framesPerChunk: 256, flushDebounceMs: 300 });

const post = (msg: any, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent) => {
  const { id, op, key, bitmap, prefix } = e.data;
  try {
    switch (op) {
      case 'put': {
        const bytes = await webpEncode(bitmap as ImageBitmap);
        await store.write(key, bytes);
        (bitmap as ImageBitmap).close();
        post({ id, ok: true });
        break;
      }
      case 'get': {
        const bytes = await store.read(key);
        if (!bytes) { post({ id, bitmap: null }); break; }
        const bmp = await webpDecode(bytes);
        post({ id, bitmap: bmp }, [bmp]);
        break;
      }
      case 'has': {
        post({ id, has: await store.has(key) });
        break;
      }
      case 'flush': {
        await store.flush();
        io.flushAll();
        post({ id, ok: true });
        break;
      }
      case 'clear': {
        await store.clear(prefix || undefined); // PackedThumbStore.clear → io.remove
        post({ id, ok: true });
        break;
      }
      case 'reopen': {
        // Models an app restart: drop in-memory indexes + handles, re-open OPFS.
        await store.flush();
        io.closeAll();
        io = new OpfsBlockIO('thumbs');
        store = new PackedThumbStore(io, { framesPerChunk: 256, flushDebounceMs: 300 });
        post({ id, ok: true });
        break;
      }
      case 'stats': {
        post({ id, stats: { size: store.size(), bytes: io.totalBytes() } });
        break;
      }
      default:
        post({ id, error: `unknown op ${op}` });
    }
  } catch (err) {
    post({ id, error: String(err) });
  }
};
