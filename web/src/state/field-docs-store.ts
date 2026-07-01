/**
 * Global (browser-wide, cross-sketch) help-text overrides.
 *
 * The "global" layer of the help-text system: a user's customized markdown for
 * a given effect's help SLOT, shared across every sketch and surface on this
 * browser. Keyed by `${effectTypeId}|${slotPath}` in IndexedDB (STORE_FIELD_DOCS).
 * The per-sketch ("local") layer lives on `InstanceState.help` instead, and the
 * effect-authored default lives in the schema — see `help-slot.ts` for how the
 * three layers resolve.
 *
 * An observable in-memory cache backs synchronous reads from render(); the first
 * read lazily hydrates the whole store, and writes are debounced to IndexedDB.
 */

import { makeAutoObservable, runInAction } from 'mobx';
import { idbGetAll, idbPut, idbDelete, STORE_FIELD_DOCS } from './idb-store';

interface FieldDocRecord {
  key: string;   // `${effectTypeId}|${slotPath}`
  text: string;
}

function docKey(effectTypeId: string, slotPath: string): string {
  return `${effectTypeId}|${slotPath}`;
}

class FieldDocsStore {
  /** key → markdown text. Observable so render() re-runs when it hydrates/changes. */
  private docs = new Map<string, string>();
  private loaded = false;
  private loading = false;
  /** Keys with unflushed writes; value undefined ⇒ delete. */
  private pending = new Map<string, string | undefined>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /** Kick off the one-time hydration from IndexedDB (idempotent). */
  private ensureLoaded() {
    if (this.loaded || this.loading) return;
    this.loading = true;
    idbGetAll<FieldDocRecord>(STORE_FIELD_DOCS).then((records) => {
      runInAction(() => {
        for (const r of records) {
          if (r && typeof r.key === 'string' && typeof r.text === 'string') {
            this.docs.set(r.key, r.text);
          }
        }
        this.loaded = true;
        this.loading = false;
      });
    }).catch((err) => {
      console.warn('[field-docs] load failed', err);
      runInAction(() => { this.loaded = true; this.loading = false; });
    });
  }

  /**
   * The global override text for a slot, or undefined if none. Triggers lazy
   * hydration on first call; observers re-render once it completes.
   */
  get(effectTypeId: string, slotPath: string): string | undefined {
    this.ensureLoaded();
    return this.docs.get(docKey(effectTypeId, slotPath));
  }

  /** Whether the initial hydration has completed (observable). */
  get isLoaded(): boolean {
    this.ensureLoaded();
    return this.loaded;
  }

  /** Set (or clear, when text is empty) the global override for a slot. */
  set(effectTypeId: string, slotPath: string, text: string) {
    const key = docKey(effectTypeId, slotPath);
    const trimmed = text ?? '';
    if (trimmed.length === 0) {
      this.docs.delete(key);
      this.pending.set(key, undefined);
    } else {
      this.docs.set(key, trimmed);
      this.pending.set(key, trimmed);
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 400);
  }

  private async flush() {
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [key, text] of batch) {
      try {
        if (text === undefined) await idbDelete(STORE_FIELD_DOCS, key);
        else await idbPut(STORE_FIELD_DOCS, { key, text } satisfies FieldDocRecord);
      } catch (err) {
        console.warn('[field-docs] save failed', key, err);
      }
    }
  }
}

export const fieldDocsStore = new FieldDocsStore();
