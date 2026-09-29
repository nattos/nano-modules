/**
 * DisplayController — the arrangement page's display devices (the devices
 * push, D3): this machine's LIBRARY of display slots (which screen fills
 * "Display 1", or a rehearsal window — displays/display-types.ts), the PLAN it
 * resolves with the show for the engine, identify, and the engine's telemetry
 * (the screens it sees, each display's status, what the viewer did) for the
 * UI.
 *
 * Like lightController, the library is app-level, not the undoable document:
 * every mutating action persists explicitly (debounced per row) and pushes the
 * plan explicitly. The SHOW's side (placements, fit, routes) lives in the
 * store, and reaches the plan through the document-ship hook (arr-displays.ts)
 * — never a reaction.
 *
 * Output is the native compositor's: the worker engine gets the same plan and
 * ignores it (a browser page can't open a window on another screen).
 */

import { makeObservable, observable, action, runInAction, toJS } from 'mobx';
import {
  displayOrdinal, displaySlotId, librarySlot, librarySlots, resolveDisplayScreen,
  BUILTIN_DISPLAY_COUNT, type DisplayScreen, type DisplaySlot, type WindowFrame,
} from '../../../displays/display-types';
import { buildDisplayPlan, type DisplayPlan } from '../../../displays/display-plan';
import { loadDisplayLibrary, saveDisplayRow, watchDisplayLibrary } from '../../../state/display-device-store';
import { store } from './store';

const SAVE_DEBOUNCE_MS = 300;

/** One display's state, as the native compositor reports it. */
export interface DisplayStatus {
  /** 'showing' | 'window' | 'opening' | 'no-screen' | 'off' | 'no-output'. */
  state: string;
  screen?: DisplayScreen;
  width?: number;
  height?: number;
  fps?: number;
  /** Offscreen targets only (tests): 16×16 RGB of what was presented, base64. */
  probe?: string;
}

/** What the viewer did to an output window (comp_report.displayEvents). */
export type DisplayEvent =
  | { type: 'closed'; placementId: string }
  | { type: 'moved'; slotId: string; frame: WindowFrame }
  | { type: 'identified'; label: string; screenUuid: string; window: boolean };

/** What the engine seam takes (arr-displays.ts binds engineBridge). */
export interface DisplayEngineSink {
  plan(plan: DisplayPlan): void;
  identify(msg: { label: string; screenUuid: string; ordinal: number; window: boolean }): void;
}

export class DisplayController {
  /** The stored rows (Display 1 / 2 only once edited). See `slots`. */
  library: DisplaySlot[] = [];
  /** The screens the native compositor sees (null: this engine can't say). */
  screens: DisplayScreen[] | null = null;
  /** placementId → its state (native compositor only). */
  status: Record<string, DisplayStatus> = {};
  /** The last identify the engine carried out (tests, and the UI's echo). */
  lastIdentified: { label: string; at: number } | null = null;

  private sink: DisplayEngineSink | null = null;
  private lastPlanJson = '';
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unwatch: (() => void) | null = null;

  constructor() {
    makeObservable<DisplayController, never>(this, {
      library: observable,
      screens: observable.ref,
      status: observable.ref,
      lastIdentified: observable.ref,
      setTelemetry: action,
    });
  }

  // ── Boot + engine ──────────────────────────────────────────────────────

  async load(): Promise<void> {
    const rows = await loadDisplayLibrary();
    runInAction(() => { this.library = rows; });
    this.unwatch ??= watchDisplayLibrary((next) => {
      runInAction(() => { this.library = next; });
      this.pushPlan();
    });
    this.pushPlan();
  }

  bindEngine(sink: DisplayEngineSink | null): void {
    this.sink = sink;
    this.lastPlanJson = '';
    this.pushPlan();
  }

  /** The plan for the current show + library → the engine (deduped). Call
   *  after anything that changes either. */
  pushPlan(): void {
    if (!this.sink) return;
    const plan = buildDisplayPlan(store.composition, this.library);
    const json = JSON.stringify(plan);
    if (json === this.lastPlanJson) return;
    this.lastPlanJson = json;
    this.sink.plan(plan);
  }

  /** The last plan sent (tests). */
  get lastPlan(): DisplayPlan | null {
    return this.lastPlanJson ? JSON.parse(this.lastPlanJson) as DisplayPlan : null;
  }

  /** Paint a slot's name over the screen it lands on (or in its window) for
   *  a moment — placed or not, on or off. */
  identify(slotId: string): void {
    const slot = this.slot(slotId);
    if (!slot) return;
    this.sink?.identify({
      label: slot.name, screenUuid: slot.screen?.uuid ?? '',
      ordinal: displayOrdinal(slot.id), window: slot.window === true,
    });
  }

  /** The engine's report. Events are acted on here: a window the viewer
   *  closed turns that display off (an undoable edit, like the toggle); a
   *  moved window is remembered. */
  setTelemetry(screens: DisplayScreen[] | undefined, status: Record<string, DisplayStatus> | undefined,
               events: DisplayEvent[] | undefined): void {
    if (screens) this.screens = screens;
    if (status) this.status = status;
    for (const e of events ?? []) {
      if (e.type === 'closed') {
        if (store.placementById(e.placementId)?.enabled !== false) store.setDisplayEnabled(e.placementId, false);
      } else if (e.type === 'moved') {
        this.setWindowFrame(e.slotId, e.frame);
      } else if (e.type === 'identified') {
        this.lastIdentified = { label: e.label, at: Date.now() };
      }
    }
  }

  // ── Library reads ──────────────────────────────────────────────────────

  /** Every slot, in order (Display 1 and 2 always). */
  get slots(): DisplaySlot[] {
    return librarySlots(this.library);
  }

  slot(id: string): DisplaySlot | undefined {
    return librarySlot(this.library, id);
  }

  /** Where a slot lands now: a connected screen, or null (a window, or no
   *  screen — see `slot.window`). Null too when the engine can't say. */
  screenFor(slot: DisplaySlot): DisplayScreen | null {
    if (!this.screens || slot.window) return null;
    const i = resolveDisplayScreen(slot, this.screens);
    return i >= 0 ? this.screens[i] : null;
  }

  /** A placed display's name: its slot's, else what the show remembers. */
  placementName(placementId: string): string {
    const p = store.placementById(placementId);
    if (!p) return 'Display';
    return librarySlot(this.library, p.deviceId, p.label)?.name ?? p.label ?? 'Display';
  }

  // ── Library edits (each persists + pushes the plan) ─────────────────────

  /** Display N+1, after the highest this machine has. */
  newDisplay(): DisplaySlot {
    const top = Math.max(BUILTIN_DISPLAY_COUNT, ...this.library.map((r) => displayOrdinal(r.id)));
    const n = top + 1;
    const row: DisplaySlot = { kind: 'display', id: displaySlotId(n), name: `Display ${n}`, updatedAt: Date.now() };
    runInAction(() => { this.library.push(row); });
    this.changed(this.library[this.library.length - 1]);
    return row;
  }

  rename(id: string, name: string): void {
    if (!name.trim()) return;
    this.edit(id, (r) => { r.name = name.trim(); });
  }

  /** Remember a screen for this slot on this machine (null: automatic). */
  bindScreen(id: string, screen: { uuid: string; name: string } | null): void {
    this.edit(id, (r) => {
      if (screen) r.screen = { uuid: screen.uuid, name: screen.name };
      else delete r.screen;
    });
  }

  /** Rehearse in a window (true) or go fullscreen on the screen (false). */
  setWindow(id: string, on: boolean): void {
    this.edit(id, (r) => {
      if (on) r.window = true; else delete r.window;
    });
  }

  setWindowFrame(id: string, frame: WindowFrame): void {
    const f = { x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h) };
    if (f.w < 64 || f.h < 64) return;
    this.edit(id, (r) => { r.windowFrame = f; });
  }

  /** Remove a slot beyond Display 2 (they always exist). A show that places
   *  it keeps it, as a slot this machine has no screen for. */
  setDeleted(id: string, deleted: boolean): void {
    if (displayOrdinal(id) <= BUILTIN_DISPLAY_COUNT) return;
    this.edit(id, (r) => { r.deleted = deleted || undefined; });
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Edit a slot's row, creating it from the default the first time. */
  private edit(id: string, fn: (r: DisplaySlot) => void): void {
    let row = this.library.find((r) => r.id === id);
    if (!row) {
      const base = librarySlot(this.library, id);
      if (!base) return;
      runInAction(() => { this.library.push({ ...base }); });
      row = this.library[this.library.length - 1];
    }
    const r = row;
    runInAction(() => { fn(r); r.updatedAt = Date.now(); });
    this.changed(r);
  }

  private changed(row: DisplaySlot) {
    this.schedulePersist(row);
    this.pushPlan();
  }

  private schedulePersist(row: DisplaySlot) {
    const prev = this.saveTimers.get(row.id);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(row.id, setTimeout(() => {
      this.saveTimers.delete(row.id);
      saveDisplayRow(toJS(row)).catch((err) =>
        console.warn('[displays] failed to persist', row.id, err));
    }, SAVE_DEBOUNCE_MS));
  }
}

export const displayController = new DisplayController();
