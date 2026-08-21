/**
 * wire-connect — the shared click/drag-to-connect state machine for wires.
 *
 * A single controller drives "connect" gestures from a source field hit-box to a
 * target field hit-box. Two gestures enter it:
 *   - DRAG: press on a field and drag past a threshold (PointerDragOp). The
 *     connection commits to whatever field is under the pointer on release.
 *   - CLICK: click an already-selected field to "pick it up"; the line then
 *     follows the cursor and the next click on a field commits (Esc / a
 *     background click cancels).
 *
 * While active, `state` holds the source + live pointer so <taps-overlay> can
 * draw the rubber-band line. Target resolution pierces shadow roots to find the
 * `.tap-overlay-hit` (field ports, in the column-group roots) under the cursor.
 *
 * GENERALIZED: the machine is parameterized by a `WireHost` (sketch lookup +
 * connectWire), so any surface — the effect IDE or the arrangement — gets the
 * same gesture by handing it a host backed by its own store. `tapsConnect` is
 * the IDE instance; other surfaces construct their own `new WireConnect(host)`.
 */

import type { FieldConnectInfo, Sketch } from '../sketch-types';
import { chainEntryAt, RESERVED_FIELD_DEFS } from '../sketch-types';
import type { PluginInfo, ColumnTaps } from './column-adapter';
import { PointerDragOp } from '../utils/pointer-drag-op';
import { observable, runInAction } from 'mobx';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';

/** The surface-specific data a wire gesture needs. */
export interface WireHost {
  getSketch(sketchId: string): Sketch | undefined;
  getPlugin(moduleType: string): PluginInfo | undefined;
  connectWire(a: FieldConnectInfo, b: FieldConnectInfo): void;
}

interface ConnectState {
  /** Field key `<sketch>/<col>/<chain>/<field>`. */
  sourceId: string;
  sketchId: string;
  info: FieldConnectInfo;
  pointerX: number;
  pointerY: number;
  /** Set by `beginRetarget`: the commit hands the clicked endpoint to this
   *  callback (which patches an EXISTING wire) instead of creating a new wire
   *  through `host.connectWire`. */
  onCommit?: (target: FieldConnectInfo) => void;
}

interface Target { key: string; info: FieldConnectInfo }

/** Everything that can receive a wire end: a field's tap-port hit-box (the
 *  expanded card, and — mid-gesture — a sidecar-canvas card) or a port pip (a
 *  canvas card's always-on ports, a collapsed card's splayed options). Both
 *  carry the same `data-*` connect dataset. */
const DROP_SELECTOR = '.tap-overlay-hit, .field-option-pip.connectable';

/** Pierce shadow roots to find the deepest element at a viewport point. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    const sr = (el as unknown as { shadowRoot: ShadowRoot | null }).shadowRoot;
    if (!sr) break;
    const inner = sr.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/**
 * True while ANY connect gesture is in flight — an OBSERVABLE flag, so a
 * surface can open drop targets for the gesture's duration (the effects list
 * renders its field hit-boxes on this, which is what lets a canvas port reach a
 * linear param without the editor being held in wire mode).
 *
 * Deliberately NOT `state` itself: that object's pointer coords change every
 * pointermove, so a render tracking it would rebuild the whole card stack per
 * frame. This flips exactly twice per gesture.
 */
const gestureActive = observable.box(false);
export function connectGestureActive(): boolean { return gestureActive.get(); }

function hitKey(hit: HTMLElement): string {
  return `${hit.dataset.sketchId}/${hit.dataset.colIdx}/${hit.dataset.chainIdx}/${hit.dataset.fieldPath}`;
}

export class WireConnect implements ColumnTaps {
  state: ConnectState | null = null;

  /** The only place `state` is written, so `gestureActive` can't drift from it. */
  private setState(s: ConnectState | null) {
    this.state = s;
    if (gestureActive.get() !== (s !== null)) {
      runInAction(() => gestureActive.set(s !== null));
    }
  }

  /** The gesture currently in CLICK mode (picked up, awaiting a target click), or
   *  null. Lets a target OUTSIDE the column-group (e.g. a return-rail lane) complete
   *  the connection itself — it must, because stopping the click from deselecting the
   *  clip also stops the document listener that would otherwise resolve the drop. */
  static active: WireConnect | null = null;

  constructor(private host: WireHost) {}

  /** Complete a CLICK-mode connection onto a rail / return endpoint. */
  completeOnRail(railId: string) {
    if (!this.state) return;
    const info: FieldConnectInfo = {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
      viewportY: this.state.pointerY, schemaDef: null, railId,
    };
    this.commit({ key: `rail/${railId}`, info });
    this.end();
  }

  /** Complete a CLICK-mode connection onto a scene / scene-track TRIGGER
   *  LISTEN endpoint (the arrangement's scene grid). */
  completeOnTriggerListen(trackId: string, sceneId?: string) {
    if (!this.state) return;
    const info: FieldConnectInfo = {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
      viewportY: this.state.pointerY, schemaDef: null,
      triggerTrack: trackId, ...(sceneId ? { triggerScene: sceneId } : {}),
    };
    this.commit({ key: `trigger/${trackId}/${sceneId ?? ''}`, info });
    this.end();
  }

  /** Complete a CLICK-mode connection onto a MIDI device control (the Devices
   *  tab's surface hit zones). The device is always the wire's writer;
   *  `controlId` is the full endpoint field, e.g. 'b0/e05/turn'. */
  completeOnDeviceControl(deviceInstanceId: string, controlId: string) {
    if (!this.state) return;
    const info: FieldConnectInfo = {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: true,
      viewportY: this.state.pointerY, schemaDef: null,
      deviceControl: { deviceInstanceId, controlId },
    };
    this.commit({ key: `device/${deviceInstanceId}/${controlId}`, info });
    this.end();
  }

  /** Complete a CLICK-mode connection onto a track/group LAYER endpoint (the
   *  arrangement's mixer strip / opacity fader). */
  completeOnLayer(ownerId: string, layerField: string = 'opacity') {
    if (!this.state) return;
    const info: FieldConnectInfo = {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
      viewportY: this.state.pointerY, schemaDef: null,
      layerOwner: ownerId, layerField,
    };
    this.commit({ key: `layer/${ownerId}/${layerField}`, info });
    this.end();
  }

  private hitToInfo(hit: HTMLElement): FieldConnectInfo | null {
    // A rail / return endpoint (e.g. an <arr-rail-lane> drop target) carries only a
    // rail id — the other endpoint supplies the device field.
    if (hit.dataset.railId) {
      const rr = hit.getBoundingClientRect();
      return { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
        viewportY: rr.top + rr.height / 2, schemaDef: null, railId: hit.dataset.railId };
    }
    // A scene / scene-track TRIGGER LISTEN endpoint (the arrangement's scene
    // grid): carries the scene track id (+ optionally one scene's id).
    if (hit.dataset.triggerTrack) {
      const rr = hit.getBoundingClientRect();
      return { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
        viewportY: rr.top + rr.height / 2, schemaDef: null,
        triggerTrack: hit.dataset.triggerTrack,
        ...(hit.dataset.triggerScene ? { triggerScene: hit.dataset.triggerScene } : {}) };
    }
    // A MIDI device control (the Devices tab): always a wire SOURCE. Carries
    // the device instance/template id + the endpoint field.
    if (hit.dataset.deviceInstance && hit.dataset.deviceControl) {
      const rr = hit.getBoundingClientRect();
      return { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: true,
        viewportY: rr.top + rr.height / 2, schemaDef: null,
        deviceControl: { deviceInstanceId: hit.dataset.deviceInstance,
                         controlId: hit.dataset.deviceControl } };
    }
    // A track/group LAYER endpoint (the arrangement's mixer strip): carries the
    // owner id + which layer param it exposes.
    if (hit.dataset.layerOwner) {
      const rr = hit.getBoundingClientRect();
      return { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
        viewportY: rr.top + rr.height / 2, schemaDef: null,
        layerOwner: hit.dataset.layerOwner,
        layerField: hit.dataset.layerField || 'opacity' };
    }
    const sketchId = hit.dataset.sketchId ?? '';
    const colIdx = parseInt(hit.dataset.colIdx ?? '-1', 10);
    const chainIdx = parseInt(hit.dataset.chainIdx ?? '-1', 10);
    const fieldPath = hit.dataset.fieldPath ?? '';
    if (!sketchId || colIdx < 0 || chainIdx < 0 || !fieldPath) return null;
    const entry = chainEntryAt(this.host.getSketch(sketchId), chainIdx);
    if (entry?.type !== 'module') return null;
    // Reserved engine keys aren't in the plugin schema — synthesize their defs.
    const schemaDef = this.host.getPlugin(entry.module_type)?.schema?.[fieldPath]
      ?? RESERVED_FIELD_DEFS[fieldPath] ?? null;
    const r = hit.getBoundingClientRect();
    return { sketchId, colIdx, chainIdx, fieldPath,
      isOutput: hit.dataset.isOutput === 'true', viewportY: r.top + r.height / 2, schemaDef };
  }

  private resolveTargetAt(x: number, y: number): Target | null {
    const el = deepElementFromPoint(x, y);
    if (!el) return null;
    const hit = el.closest?.(DROP_SELECTOR) as HTMLElement | null;
    if (!hit) return null;
    const info = this.hitToInfo(hit);
    return info ? { key: hitKey(hit), info } : null;
  }

  // Bound document listeners for CLICK mode (kept so we can remove them).
  private onDocMove = (e: PointerEvent) => this.updatePointer(e.clientX, e.clientY);
  private onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.cancel(); };
  private onDocDown = (e: PointerEvent) => {
    const t = this.resolveTargetAt(e.clientX, e.clientY);
    if (!t) this.cancel();
  };
  private clickListenersActive = false;

  private lastDropEl: HTMLElement | null = null;

  // --- Begins ---

  /** Pick up a field on a second click (CLICK mode). */
  beginFromFieldClick(sketchId: string, key: string, info: FieldConnectInfo) {
    this.start({ sourceId: key, sketchId, info,
      pointerX: info.viewportY, pointerY: info.viewportY });
    this.installClickListeners();
  }

  /**
   * CLICK-mode pickup that RE-TARGETS an existing wire ("reconnect"): the next
   * endpoint clicked is handed to `onCommit` — which patches the wire in place,
   * keeping its settings — instead of `connectWire` creating a fresh one.
   * `key`/`info` anchor the rubber band (the field the wire is being picked up
   * from); Esc / a background click cancels as usual.
   */
  beginRetarget(sketchId: string, key: string, info: FieldConnectInfo,
                onCommit: (target: FieldConnectInfo) => void) {
    this.start({ sourceId: key, sketchId, info,
      pointerX: info.viewportY, pointerY: info.viewportY, onCommit });
    this.installClickListeners();
  }

  /** Start a DRAG-to-connect from a field hit-box. */
  beginFromFieldDrag(e: PointerEvent, srcEl: HTMLElement, sketchId: string, key: string, info: FieldConnectInfo) {
    this.beginDrag(e, srcEl, { sourceId: key, sketchId, info,
      pointerX: e.clientX, pointerY: e.clientY });
  }

  private beginDrag(e: PointerEvent, srcEl: HTMLElement, base: ConnectState) {
    if (e.button !== 0) return;
    new PointerDragOp(e, srcEl, {
      threshold: 5,
      move: (me) => {
        if (!this.state) this.setState({ ...base });
        this.updatePointer(me.clientX, me.clientY);
      },
      accept: (me) => {
        if (this.state) {
          const t = this.resolveTargetAt(me.clientX, me.clientY);
          if (t) this.commit(t);
        }
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);
        this.end();
      },
      cancel: () => this.end(),
    });
  }

  /** True once if a just-finished drag should eat the trailing click. */
  consumeClickSuppression(): boolean {
    const s = this.suppressClick;
    this.suppressClick = false;
    return s;
  }
  private suppressClick = false;

  private start(s: ConnectState) {
    this.end();
    this.setState(s);
  }

  private installClickListeners() {
    if (this.clickListenersActive) return;
    this.clickListenersActive = true;
    WireConnect.active = this;
    setTimeout(() => {
      if (!this.state) return;
      document.addEventListener('pointermove', this.onDocMove);
      document.addEventListener('pointerdown', this.onDocDown);
      document.addEventListener('keydown', this.onDocKey);
    }, 0);
  }

  // --- Pointer / highlight ---

  private dropRaf = 0;

  private updatePointer(x: number, y: number) {
    if (!this.state) return;
    this.state.pointerX = x;
    this.state.pointerY = y;
    if (this.dropRaf) return;
    this.dropRaf = requestAnimationFrame(() => {
      this.dropRaf = 0;
      if (!this.state) return;
      this.refreshDropTarget(this.state.pointerX, this.state.pointerY);
    });
  }

  private refreshDropTarget(x: number, y: number) {
    const el = deepElementFromPoint(x, y);
    // Same selector the drop itself resolves against — highlighting only row
    // hit-boxes left every canvas port silently un-lit under the pointer.
    const drop = el?.closest?.(DROP_SELECTOR) as HTMLElement | null;
    if (drop === this.lastDropEl) return;
    this.lastDropEl?.removeAttribute('tap-drop-target');
    if (drop) drop.setAttribute('tap-drop-target', '');
    this.lastDropEl = drop;
  }

  // --- Completes (called from field-hit element handlers) ---

  completeOnField(key: string, info?: FieldConnectInfo) {
    if (!this.state) return;
    // Prefer the caller's structured info (the column-group has it directly). Re-parsing
    // the key by '/' breaks when the sketchId itself contains slashes — e.g. the
    // arrangement's `clip/<track>/<clip>` — which silently dropped click-to-connect there.
    const t = info ? { key, info } : this.fieldTargetByKey(key);
    if (t) this.commit(t);
    this.end();
  }

  private fieldTargetByKey(key: string): Target | null {
    // Build the target straight from the host — the hit elements live inside
    // nested shadow roots that a document query can't reach. Output bit = io&2.
    const [sketchId, colStr, chainStr, ...fp] = key.split('/');
    const colIdx = +colStr, chainIdx = +chainStr;
    const fieldPath = fp.join('/');
    const entry = chainEntryAt(this.host.getSketch(sketchId), chainIdx);
    if (entry?.type !== 'module') return null;
    const schemaDef = this.host.getPlugin(entry.module_type)?.schema?.[fieldPath]
      ?? RESERVED_FIELD_DEFS[fieldPath] ?? null;
    const info: FieldConnectInfo = {
      sketchId, colIdx, chainIdx, fieldPath,
      isOutput: !!(((schemaDef as any)?.io ?? 0) & 2),
      viewportY: this.state?.pointerY ?? 0,
      schemaDef,
    };
    return { key, info };
  }

  // --- Commit ---

  private commit(target: Target) {
    const s = this.state;
    if (!s) return;
    if (s.onCommit) s.onCommit(target.info);
    else this.host.connectWire(s.info, target.info);
  }

  cancel() { this.end(); }

  private end() {
    this.setState(null);
    if (WireConnect.active === this) WireConnect.active = null;
    if (this.dropRaf) { cancelAnimationFrame(this.dropRaf); this.dropRaf = 0; }
    this.lastDropEl?.removeAttribute('tap-drop-target');
    this.lastDropEl = null;
    if (this.clickListenersActive) {
      this.clickListenersActive = false;
      document.removeEventListener('pointermove', this.onDocMove);
      document.removeEventListener('pointerdown', this.onDocDown);
      document.removeEventListener('keydown', this.onDocKey);
    }
  }
}

/** Shared IDE singleton — backed by appState / appController. */
export const tapsConnect = new WireConnect({
  getSketch: (id) => appState.database.sketches[id],
  getPlugin: (mt) => appState.local.plugins.find((p) => p.id === mt) as PluginInfo | undefined,
  connectWire: (a, b) => appController.connectWire(a, b),
});
