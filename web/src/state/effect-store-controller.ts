/**
 * The Effects (store) tab's session state and actions.
 *
 * The store can act on a card in two ways:
 *
 *   - PREVIEW ("hot swap"): put the effect in place live, as an uncommitted
 *     long edit, without leaving the store — every further Preview retargets
 *     the same edit; leaving the store without Use reverts it;
 *   - USE: commit it (the previewed edit, or a fresh one).
 *
 * Where it lands depends on the TARGET:
 *
 *   - arriving from the type editor (Browse… on a card being retyped, or on an
 *     insert in progress) sets a target — a breadcrumb back to that card or
 *     insert position — and Use returns there;
 *   - without a target, both insert a NEW effect into the current sketch,
 *     after its selected card or at the end of its linear list (the rule the
 *     insert chips use), and the store stays open with the new card selected
 *     so the next insert lands after it.
 *
 * The surface (sketch-app / effect-ide-app) binds how tabs are switched and
 * which sketch is current: the two keep those in different settings.
 */

import { observable, runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { LongEdit } from './history';
import { defaultInsertIndex } from './insert-position';
import { sketchChain } from '../sketch-types';
import { PreviewEngine } from '../preview/preview-engine';
import { Thumbnails } from '../preview/thumbnails';

export const STORE_TAB_ID = 'store';

export type StoreTarget =
  | { kind: 'retype'; sketchId: string; instanceKey: string; returnTab: string;
      /** The card's type when Browse… was pressed (a preview changes the live one). */
      originalType?: string }
  | { kind: 'insert'; sketchId: string; index: number; returnTab: string };

interface ActivePreview {
  effectId: string;
  edit: LongEdit;
  sketchId: string;
  /** retype: the card being retyped. insert: the placeholder's key. */
  instanceKey: string;
  kind: 'retype' | 'insert';
  /** insert only: where the placeholder sits. */
  index: number;
}

export interface StoreSurface {
  /** The surface's active tab id. */
  currentTab(): string;
  selectTab(id: string): void;
  /** The sketch the editor has open, or null. */
  currentSketchId(): string | null;
}

class EffectStoreController {
  readonly target = observable.box<StoreTarget | null>(null, { deep: false });
  readonly preview = observable.box<ActivePreview | null>(null, { deep: false });
  private surface: StoreSurface | null = null;
  private engine: PreviewEngine | null = null;
  private thumbs: Thumbnails | null = null;
  private opens = 0;

  bindSurface(surface: StoreSurface) { this.surface = surface; }

  /** The store view mounted: start (or reuse) the preview engine. */
  open(): { engine: PreviewEngine; thumbs: Thumbnails } {
    this.opens++;
    if (!this.engine) {
      this.engine = new PreviewEngine();
      this.thumbs = new Thumbnails(this.engine);
      void this.engine.start().catch((e) => console.warn('[effect-store] preview engine failed', e));
    }
    return { engine: this.engine, thumbs: this.thumbs! };
  }

  /** The store view unmounted (the user left the tab). Reverts any
   *  uncommitted preview and frees the preview engine. */
  close() {
    this.opens = Math.max(0, this.opens - 1);
    if (this.opens > 0) return;
    this.cancelPreview();
    // A breadcrumb only means something while the store is open.
    runInAction(() => this.target.set(null));
    this.thumbs?.dispose();
    this.engine?.dispose();
    this.thumbs = null;
    this.engine = null;
  }

  // ── Arriving and leaving ───────────────────────────────────────────────

  /** Open the store to pick a type for `target` (the type editor's Browse…). */
  browseFor(target:
    | { kind: 'retype'; sketchId: string; instanceKey: string }
    | { kind: 'insert'; sketchId: string; index: number }) {
    const returnTab = this.surface?.currentTab() ?? 'edit';
    let originalType: string | undefined;
    if (target.kind === 'retype') {
      const sk = appState.database.sketches[target.sketchId];
      originalType = sk ? sketchChain(sk).find((e) => e.instance_key === target.instanceKey)?.module_type : undefined;
    }
    runInAction(() => this.target.set({ ...target, returnTab, ...(originalType ? { originalType } : {}) } as StoreTarget));
    this.surface?.selectTab(STORE_TAB_ID);
  }

  /** Back to where the breadcrumb came from, dropping any preview. */
  back() {
    const t = this.target.get();
    this.cancelPreview();
    runInAction(() => this.target.set(null));
    if (t) {
      this.surface?.selectTab(t.returnTab);
      const idx = this.indexOf(t.sketchId, t.kind === 'retype' ? t.instanceKey : null);
      if (idx != null) appController.select(`effect/${t.sketchId}/0/${idx}`);
    }
  }

  // ── Acting on a card ───────────────────────────────────────────────────

  /** Where an insert with no target lands. */
  private freeInsert(): { sketchId: string; index: number } | null {
    const sketchId = this.surface?.currentSketchId() ?? null;
    if (!sketchId) return null;
    const sk = appState.database.sketches[sketchId];
    if (!sk) return null;
    return { sketchId, index: defaultInsertIndex(sk, sketchId, 0, (p) => appController.isSelected(p)) };
  }

  private indexOf(sketchId: string, instanceKey: string | null): number | null {
    if (!instanceKey) return null;
    const sk = appState.database.sketches[sketchId];
    if (!sk) return null;
    const i = sketchChain(sk).findIndex((e) => e.instance_key === instanceKey);
    return i < 0 ? null : i;
  }

  /** Can Use/Preview act right now (is there anywhere to put an effect)? */
  canPlace(): boolean {
    const t = this.target.get();
    if (t) return !!appState.database.sketches[t.sketchId];
    return this.freeInsert() !== null;
  }

  /** Hot swap: show `effectId` in place, uncommitted. Previewing the one
   *  already previewed stops the preview. */
  togglePreview(effectId: string) {
    const cur = this.preview.get();
    if (cur?.effectId === effectId) { this.cancelPreview(); return; }
    if (cur) { this.retarget(cur, effectId); return; }
    const t = this.target.get();
    if (t?.kind === 'retype') {
      const idx = this.indexOf(t.sketchId, t.instanceKey);
      if (idx == null) return;
      const edit = appController.beginChangeEffectType(t.sketchId, 0, idx, effectId);
      this.setPreview({ effectId, edit, sketchId: t.sketchId, instanceKey: t.instanceKey, kind: 'retype', index: idx });
      return;
    }
    const at = t?.kind === 'insert' ? { sketchId: t.sketchId, index: t.index } : this.freeInsert();
    if (!at) return;
    const { edit, instanceKey } = appController.beginInsertEffect(at.sketchId, 0, at.index, effectId);
    this.setPreview({ effectId, edit, sketchId: at.sketchId, instanceKey, kind: 'insert', index: at.index });
  }

  private retarget(cur: ActivePreview, effectId: string) {
    if (cur.kind === 'retype') {
      const idx = this.indexOf(cur.sketchId, cur.instanceKey) ?? cur.index;
      appController.updateChangeEffectType(cur.edit, cur.sketchId, 0, idx, effectId);
    } else {
      appController.updateInsertEffect(cur.edit, cur.sketchId, 0, cur.index, cur.instanceKey, effectId);
    }
    this.setPreview({ ...cur, effectId });
  }

  private setPreview(p: ActivePreview | null) {
    runInAction(() => this.preview.set(p));
  }

  /** Revert an uncommitted preview (no-op without one). */
  cancelPreview() {
    const cur = this.preview.get();
    if (!cur) return;
    if (cur.kind === 'retype') appController.cancelChangeEffectType(cur.edit);
    else appController.cancelInsertEffect(cur.edit);
    this.setPreview(null);
  }

  /** Commit `effectId` to the target (or into the current sketch). */
  use(effectId: string) {
    const cur = this.preview.get();
    if (cur && cur.effectId !== effectId) this.retarget(cur, effectId);
    const t = this.target.get();
    let placed: { sketchId: string; index: number } | null = null;
    if (cur) {
      cur.edit.accept();
      placed = { sketchId: cur.sketchId, index: this.indexOf(cur.sketchId, cur.instanceKey) ?? cur.index };
      this.setPreview(null);
    } else if (t?.kind === 'retype') {
      const idx = this.indexOf(t.sketchId, t.instanceKey);
      if (idx == null) return;
      appController.changeEffectType(t.sketchId, 0, idx, effectId);
      placed = { sketchId: t.sketchId, index: idx };
    } else {
      const at = t?.kind === 'insert' ? { sketchId: t.sketchId, index: t.index } : this.freeInsert();
      if (!at) return;
      appController.addEffectToChain(at.sketchId, 0, at.index, effectId);
      placed = at;
    }
    if (t) {
      runInAction(() => this.target.set(null));
      this.surface?.selectTab(t.returnTab);
    }
    if (placed) appController.select(`effect/${placed.sketchId}/0/${placed.index}`);
  }
}

export const effectStore = new EffectStoreController();
