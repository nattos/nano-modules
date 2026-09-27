/**
 * Thumbnails — the effect store's view of the cache + the preview engine.
 *
 * A card asks for its effect's thumbnail when it scrolls into view. A cached
 * image whose key still matches (thumbnail-cache.ts) is shown at once; anything
 * missing or stale is queued and baked on the preview engine, one at a time,
 * most recently requested first (so what's on screen goes before what was
 * scrolled past). Baking yields to a live hover preview: the engine drops the
 * bake in progress and it is re-queued.
 */

import { observable, runInAction } from 'mobx';
import type { EffectInfo } from '../engine-types';
import type { PreviewEngine } from './preview-engine';
import { bundleHash, getThumb, putThumb, thumbKey } from './thumbnail-cache';

export interface ThumbView {
  url: string;
  kind: 'image' | 'graph';
}

export class Thumbnails {
  /** effect id → object URL of its current thumbnail (UI-observable). */
  readonly views = observable.map<string, ThumbView>({}, { deep: false });
  private queue: EffectInfo[] = [];
  private queued = new Set<string>();
  private checked = new Set<string>();
  private running = false;
  private disposed = false;
  /** Newly visible cards jump the queue as a BATCH, in reading order: requests
   *  within one burst insert after each other at the front. */
  private batchAt = 0;
  private batchTime = 0;

  constructor(private engine: PreviewEngine) {}

  /** Show `effect`'s thumbnail, baking it if the cache has no current one. */
  request(effect: EffectInfo) {
    if (this.disposed) return;
    if (this.checked.has(effect.id)) {
      // Already resolved (or queued): just move a queued bake to the front.
      if (this.queued.has(effect.id)) {
        this.queue = [effect, ...this.queue.filter((e) => e.id !== effect.id)];
      }
      return;
    }
    this.checked.add(effect.id);
    void this.lookup(effect);
  }

  /** Forget everything (bundles changed): the next request re-checks. */
  invalidate() {
    this.checked.clear();
    this.queue = [];
    this.queued.clear();
  }

  private async keyFor(effect: EffectInfo): Promise<string> {
    return thumbKey(await bundleHash(effect.bundle ?? effect.id), effect.preview);
  }

  private async lookup(effect: EffectInfo) {
    const [rec, key] = await Promise.all([getThumb(effect.id), this.keyFor(effect)]);
    if (this.disposed) return;
    if (rec) this.show(effect.id, rec.blob, rec.kind);
    if (rec?.key === key) return;
    this.queued.add(effect.id);
    const now = performance.now();
    if (now - this.batchTime > 120) this.batchAt = 0;
    this.batchTime = now;
    this.queue.splice(Math.min(this.batchAt++, this.queue.length), 0, effect);
    void this.pump();
  }

  private show(effectId: string, blob: Blob, kind: 'image' | 'graph') {
    const url = URL.createObjectURL(blob);
    runInAction(() => {
      const old = this.views.get(effectId);
      if (old) URL.revokeObjectURL(old.url);
      this.views.set(effectId, { url, kind });
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        if (this.engine.liveEffect.get()) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        const effect = this.queue.shift()!;
        const key = await this.keyFor(effect);
        const baked = await this.engine.bakeThumbnail(effect);
        if (this.disposed) return;
        if (!baked) {
          // Interrupted by a live preview (or no frame yet): try again later.
          if (this.engine.liveEffect.get()) this.queue.push(effect);
          else this.queued.delete(effect.id);
          continue;
        }
        this.queued.delete(effect.id);
        this.show(effect.id, baked.blob, baked.kind);
        await putThumb({ effectId: effect.id, key, blob: baked.blob, kind: baked.kind });
      }
    } finally {
      this.running = false;
    }
  }

  dispose() {
    this.disposed = true;
    runInAction(() => {
      for (const v of this.views.values()) URL.revokeObjectURL(v.url);
      this.views.clear();
    });
  }
}
