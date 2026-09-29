/**
 * LightController — the arrangement page's light devices (the devices push,
 * D2): the per-machine LIBRARY of types and rigs (lights/light-types.ts), the
 * PLAN it resolves with the show for the engine, identify / test patterns, and
 * the engine's telemetry (the colours each light is showing, the transmitter's
 * status) for the UI.
 *
 * Like midiController, the library is app-level, not the undoable document:
 * every mutating action persists explicitly (debounced per row) and pushes the
 * plan explicitly. The SHOW's side (placements, per-show layout, routes) lives
 * in the store, and reaches the plan through the document-ship hook
 * (arr-lights.ts) — never a reaction.
 *
 * Output is the native compositor's: the worker engine gets the same plan and
 * ignores it (no UDP in a browser).
 */

import { makeObservable, observable, action, runInAction, toJS } from 'mobx';
import {
  consecutiveAddresses, defaultStripLayout, lightTemplate, LIGHT_TEMPLATES,
  type LightAddress, type LightRig, type LightRow, type LightSlot, type LightType,
} from '../../../lights/light-types';
import { buildLightPlan, libraryRig, libraryType, type LightPlan } from '../../../lights/light-plan';
import { loadLightLibrary, saveLightRow, watchLightLibrary } from '../../../state/light-device-store';
import { store } from './store';

const SAVE_DEBOUNCE_MS = 300;

export type LightPattern = 'off' | 'white' | 'colors' | 'chase' | 'numbers' | 'bars' | 'identify';

export interface LightStatus {
  sending: boolean;
  pps: number;
  error?: string;
}

/** What the engine seam takes (arr-lights.ts binds engineBridge). */
export interface LightEngineSink {
  plan(plan: LightPlan): void;
  test(placementId: string, slotId: string, pattern: LightPattern | ''): void;
}

function uuid(): string {
  return crypto.randomUUID();
}

export class LightController {
  /** Every row, soft-deleted included (oldest first). */
  library: LightRow[] = [];
  /** The last colours per light placement (RGB bytes, every slot's pixels in
   *  rig order) — engine telemetry, UI only. */
  values: Record<string, Uint8Array> = {};
  /** The transmitter's status (null: this engine doesn't transmit). */
  status: LightStatus | null = null;
  /** A running test pattern per placement (UI highlight). */
  testing: Record<string, { slotId: string; pattern: LightPattern }> = {};

  private sink: LightEngineSink | null = null;
  private lastPlanJson = '';
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unwatch: (() => void) | null = null;

  constructor() {
    makeObservable<LightController, never>(this, {
      library: observable,
      values: observable.ref,
      status: observable.ref,
      testing: observable,
      setTelemetry: action,
    });
  }

  // ── Boot + engine ──────────────────────────────────────────────────────

  async load(): Promise<void> {
    const rows = await loadLightLibrary();
    runInAction(() => { this.library = rows; });
    this.unwatch ??= watchLightLibrary((next) => {
      runInAction(() => { this.library = next; });
      this.pushPlan();
    });
    this.pushPlan();
  }

  bindEngine(sink: LightEngineSink | null): void {
    this.sink = sink;
    this.lastPlanJson = '';
    this.pushPlan();
  }

  /** The plan for the current show + library → the engine (deduped). Call
   *  after anything that changes either. */
  pushPlan(): void {
    if (!this.sink) return;
    const plan = buildLightPlan(store.composition, this.library);
    const json = JSON.stringify(plan);
    if (json === this.lastPlanJson) return;
    this.lastPlanJson = json;
    this.sink.plan(plan);
  }

  /** Start / stop (`pattern` null) a test pattern on a placed light, or one
   *  slot of it. Identify stops itself after 5 s (engine-side too). */
  test(placementId: string, slotId: string | null, pattern: LightPattern | null): void {
    runInAction(() => {
      if (pattern) this.testing[placementId] = { slotId: slotId ?? '', pattern };
      else delete this.testing[placementId];
    });
    this.sink?.test(placementId, slotId ?? '', pattern ?? '');
    if (pattern === 'identify') {
      setTimeout(() => runInAction(() => {
        if (this.testing[placementId]?.pattern === 'identify') delete this.testing[placementId];
      }), 5000);
    }
  }

  /** The engine's report: colours (base64 RGB per placement) and status. */
  setTelemetry(lights: Record<string, string> | undefined, status: LightStatus | undefined): void {
    if (lights) {
      const next: Record<string, Uint8Array> = {};
      for (const [pid, b64] of Object.entries(lights)) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        next[pid] = bytes;
      }
      this.values = next;
    }
    if (status) this.status = status;
  }

  // ── Library reads ──────────────────────────────────────────────────────

  get types(): LightType[] {
    return this.library.filter((r): r is LightType => r.kind === 'type' && !r.deleted);
  }

  get rigs(): LightRig[] {
    return this.library.filter((r): r is LightRig => r.kind === 'rig' && !r.deleted);
  }

  type(id: string): LightType | undefined {
    return libraryType(this.library, id);
  }

  rig(id: string): LightRig | undefined {
    return libraryRig(this.library, id);
  }

  row(id: string): LightRow | undefined {
    return this.library.find((r) => r.id === id);
  }

  /** A placed light's name: its rig's, else what the show remembers. */
  placementName(placementId: string): string {
    const p = store.placementById(placementId);
    if (!p) return 'Light';
    return this.rig(p.deviceId)?.name ?? p.label ?? 'Missing light';
  }

  // ── Library edits (each persists + pushes the plan) ─────────────────────

  /** A new type from a template (or a copy of another type). */
  newType(from: string): LightType | null {
    const src = this.type(from);
    const tpl = src ? lightTemplate(src.templateId) : lightTemplate(from);
    if (!tpl) return null;
    const base = src ?? { ...tpl.defaults, templateId: tpl.templateId };
    const now = Date.now();
    const row: LightType = {
      kind: 'type', id: uuid(), templateId: base.templateId, parentId: from,
      name: this.uniqueName(src ? `${src.name} copy` : tpl.name),
      pixels: base.pixels, ledsPerPixel: base.ledsPerPixel, format: base.format, gamma: base.gamma,
      vertical: base.vertical !== false,
      forkedAt: now, updatedAt: now,
    };
    this.add(row);
    return row;
  }

  /**
   * Edit a type. Turning it (vertical ↔ horizontal) also lays the rigs'
   * slots of it out again the new way — a thin vertical strip read across
   * would be nonsense. A show's own layout for them is the show's (its "reset
   * to rig layout" picks the new one up).
   */
  editType(id: string, patch: Partial<Pick<LightType, 'name' | 'pixels' | 'ledsPerPixel' | 'format' | 'gamma' | 'vertical'>>): void {
    const t = this.type(id);
    if (!t) return;
    const turned = patch.vertical !== undefined && patch.vertical !== (t.vertical !== false);
    const relaid: LightRig[] = [];
    runInAction(() => {
      Object.assign(t, patch);
      t.pixels = Math.max(1, Math.min(512, Math.round(t.pixels)));
      t.ledsPerPixel = Math.max(1, Math.min(64, Math.round(t.ledsPerPixel)));
      t.gamma = Math.max(0.1, Math.min(5, t.gamma));
      t.updatedAt = Date.now();
      if (!turned) return;
      for (const r of this.rigs) {
        if (!r.slots.some((s) => s.typeId === id)) continue;
        r.slots.forEach((s, i) => {
          if (s.typeId === id) s.layout = defaultStripLayout(i, r.slots.length, t.vertical);
        });
        r.updatedAt = Date.now();
        relaid.push(r);
      }
    });
    this.changed(t);
    for (const r of relaid) this.changed(r);
  }

  /**
   * A new rig of `count` bars of one type, addressed one after another from
   * `start`, laid out as strips across the frame (vertical types) or down it.
   */
  newRig(opts: { typeId: string; count: number; start: LightAddress; name?: string }): LightRig | null {
    const type = this.type(opts.typeId);
    if (!type) return null;
    const count = Math.max(1, Math.min(64, Math.round(opts.count)));
    const addrs = consecutiveAddresses(count, type, opts.start);
    const now = Date.now();
    const row: LightRig = {
      kind: 'rig', id: uuid(), parentId: type.id,
      name: this.uniqueName(opts.name?.trim() || `${count} × ${type.name}`),
      slots: addrs.map((address, i) => ({
        id: uuid(), typeId: type.id, address, layout: defaultStripLayout(i, count, type.vertical !== false),
      })),
      forkedAt: now, updatedAt: now,
    };
    this.add(row);
    return row;
  }

  renameRig(id: string, name: string): void {
    const r = this.rig(id);
    if (!r || !name.trim()) return;
    runInAction(() => { r.name = name.trim(); r.updatedAt = Date.now(); });
    this.changed(r);
  }

  editSlot(rigId: string, slotId: string,
           patch: Partial<Pick<LightSlot, 'typeId' | 'reverse' | 'layout'>> & { address?: Partial<LightAddress> }): void {
    const r = this.rig(rigId);
    const s = r?.slots.find((x) => x.id === slotId);
    if (!r || !s) return;
    runInAction(() => {
      if (patch.typeId !== undefined) s.typeId = patch.typeId;
      if (patch.reverse !== undefined) s.reverse = patch.reverse || undefined;
      if (patch.layout) s.layout = { ...patch.layout };
      if (patch.address) {
        const a = { ...s.address, ...patch.address };
        a.universe = Math.max(0, Math.min(0x7fff, Math.round(a.universe)));
        a.channel = Math.max(1, Math.min(512, Math.round(a.channel)));
        a.dest = (a.dest ?? '').trim() || 'broadcast';
        s.address = a;
      }
      r.updatedAt = Date.now();
    });
    this.changed(r);
  }

  /** Another slot like the last one, addressed right after it. */
  addSlot(rigId: string): void {
    const r = this.rig(rigId);
    if (!r) return;
    const last = r.slots[r.slots.length - 1];
    const type = last ? this.type(last.typeId) : this.types[0];
    if (!type) return;
    const start = last
      ? consecutiveAddresses(2, type, last.address)[1]
      : { universe: 0, channel: 1, dest: 'broadcast' };
    const n = r.slots.length + 1;
    runInAction(() => {
      r.slots.push({ id: uuid(), typeId: type.id, address: start, layout: defaultStripLayout(n - 1, n, type.vertical !== false) });
      r.updatedAt = Date.now();
    });
    this.changed(r);
  }

  removeSlot(rigId: string, slotId: string): void {
    const r = this.rig(rigId);
    if (!r || r.slots.length <= 1) return;
    runInAction(() => {
      r.slots = r.slots.filter((s) => s.id !== slotId);
      r.updatedAt = Date.now();
    });
    this.changed(r);
  }

  /**
   * Two bars went up in each other's places: exchange what the slots SEND TO
   * (address, type, orientation) and keep where they SAMPLE. In the library,
   * so every show using this rig is fixed at once.
   */
  swapSlots(rigId: string, aId: string, bId: string): void {
    const r = this.rig(rigId);
    const a = r?.slots.find((s) => s.id === aId);
    const b = r?.slots.find((s) => s.id === bId);
    if (!r || !a || !b || a === b) return;
    runInAction(() => {
      const hold = { typeId: a.typeId, address: a.address, reverse: a.reverse };
      a.typeId = b.typeId; a.address = b.address; a.reverse = b.reverse;
      b.typeId = hold.typeId; b.address = hold.address; b.reverse = hold.reverse;
      r.updatedAt = Date.now();
    });
    this.changed(r);
  }

  setDeleted(id: string, deleted: boolean): void {
    const row = this.row(id);
    if (!row) return;
    runInAction(() => { row.deleted = deleted || undefined; row.updatedAt = Date.now(); });
    this.changed(row);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private add(row: LightRow) {
    runInAction(() => { this.library.push(row); });
    this.changed(this.library[this.library.length - 1]);
  }

  private changed(row: LightRow) {
    this.schedulePersist(row);
    this.pushPlan();
  }

  private uniqueName(base: string): string {
    const names = new Set(this.library.map((r) => r.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  private schedulePersist(row: LightRow) {
    const prev = this.saveTimers.get(row.id);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(row.id, setTimeout(() => {
      this.saveTimers.delete(row.id);
      saveLightRow(toJS(row)).catch((err) =>
        console.warn('[lights] failed to persist', row.id, err));
    }, SAVE_DEBOUNCE_MS));
  }
}

export const lightController = new LightController();
export { LIGHT_TEMPLATES };
