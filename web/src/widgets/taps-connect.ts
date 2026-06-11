/**
 * taps-connect — the shared click/drag-to-connect state machine for taps.
 *
 * A single module-level controller drives "connect" gestures from a source
 * (a field hit-box or a rail badge) to a target (another field, a rail badge,
 * or the "+ New" badge). Two gestures enter it:
 *   - DRAG: press on a source and drag past a threshold (PointerDragOp). The
 *     connection commits to whatever is under the pointer on release.
 *   - CLICK: click an already-selected source to "pick it up"; the line then
 *     follows the cursor and the next click on a target commits (Esc / a
 *     background click cancels).
 *
 * While active, `state` holds the source + live pointer so <taps-overlay> can
 * draw the rubber-band line. Target resolution pierces shadow roots to find the
 * `.tap-overlay-hit` (fields, in the column-group roots) or `.badge` (rails, in
 * the overlay root) under the cursor.
 */

import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { FieldConnectInfo } from '../state/controller';
import { PointerDragOp } from '../utils/pointer-drag-op';

export const NEW_BADGE_ID = '__new__';

interface ConnectState {
  sourceKind: 'field' | 'rail';
  /** field key `<sketch>/<col>/<chain>/<field>` or railId. */
  sourceId: string;
  sketchId: string;
  info?: FieldConnectInfo; // present for field sources
  pointerX: number;
  pointerY: number;
}

type Target =
  | { kind: 'field'; key: string; info: FieldConnectInfo }
  | { kind: 'rail'; railId: string }
  | { kind: 'new' };

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

function hitKey(hit: HTMLElement): string {
  return `${hit.dataset.sketchId}/${hit.dataset.colIdx}/${hit.dataset.chainIdx}/${hit.dataset.fieldPath}`;
}

function hitToInfo(hit: HTMLElement): FieldConnectInfo | null {
  const sketchId = hit.dataset.sketchId ?? '';
  const colIdx = parseInt(hit.dataset.colIdx ?? '-1', 10);
  const chainIdx = parseInt(hit.dataset.chainIdx ?? '-1', 10);
  const fieldPath = hit.dataset.fieldPath ?? '';
  if (!sketchId || colIdx < 0 || chainIdx < 0 || !fieldPath) return null;
  const entry = appState.database.sketches[sketchId]?.columns[colIdx]?.chain[chainIdx];
  if (entry?.type !== 'module') return null;
  const schemaDef = appState.local.plugins.find(p => p.id === entry.module_type)?.schema?.[fieldPath] ?? null;
  const r = hit.getBoundingClientRect();
  return { sketchId, colIdx, chainIdx, fieldPath,
    isOutput: hit.dataset.isOutput === 'true', viewportY: r.top + r.height / 2, schemaDef };
}

function resolveTargetAt(x: number, y: number): Target | null {
  const el = deepElementFromPoint(x, y);
  if (!el) return null;
  const hit = el.closest?.('.tap-overlay-hit') as HTMLElement | null;
  if (hit) {
    const info = hitToInfo(hit);
    return info ? { kind: 'field', key: hitKey(hit), info } : null;
  }
  const badge = el.closest?.('.badge') as HTMLElement | null;
  if (badge) {
    const rid = badge.dataset.railId ?? '';
    return rid === NEW_BADGE_ID ? { kind: 'new' } : { kind: 'rail', railId: rid };
  }
  return null;
}

class TapsConnect {
  state: ConnectState | null = null;

  // Bound document listeners for CLICK mode (kept so we can remove them).
  private onDocMove = (e: PointerEvent) => this.updatePointer(e.clientX, e.clientY);
  private onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.cancel(); };
  private onDocDown = (e: PointerEvent) => {
    // A click in CLICK mode: commit if over a target, else cancel. Element-level
    // handlers (badge / field) also call complete*, so only act on background here.
    const t = resolveTargetAt(e.clientX, e.clientY);
    if (!t) this.cancel();
  };
  private clickListenersActive = false;

  private lastDropEl: HTMLElement | null = null;

  // --- Begins ---

  /** Pick up a field on a second click (CLICK mode). */
  beginFromFieldClick(sketchId: string, key: string, info: FieldConnectInfo) {
    this.start({ sourceKind: 'field', sourceId: key, sketchId, info,
      pointerX: info.viewportY, pointerY: info.viewportY });
    this.installClickListeners();
  }

  /** Pick up a rail badge on a click (CLICK mode). */
  beginFromRailClick(sketchId: string, railId: string, x: number, y: number) {
    this.start({ sourceKind: 'rail', sourceId: railId, sketchId, pointerX: x, pointerY: y });
    this.installClickListeners();
  }

  /** Start a DRAG-to-connect from a field hit-box. */
  beginFromFieldDrag(e: PointerEvent, srcEl: HTMLElement, sketchId: string, key: string, info: FieldConnectInfo) {
    this.beginDrag(e, srcEl, { sourceKind: 'field', sourceId: key, sketchId, info,
      pointerX: e.clientX, pointerY: e.clientY });
  }

  /** Start a DRAG-to-connect from a rail badge. */
  beginFromRailDrag(e: PointerEvent, srcEl: HTMLElement, sketchId: string, railId: string) {
    this.beginDrag(e, srcEl, { sourceKind: 'rail', sourceId: railId, sketchId,
      pointerX: e.clientX, pointerY: e.clientY });
  }

  private beginDrag(e: PointerEvent, srcEl: HTMLElement, base: ConnectState) {
    if (e.button !== 0) return;
    new PointerDragOp(e, srcEl, {
      threshold: 5,
      move: (me) => {
        if (!this.state) this.state = { ...base };
        this.updatePointer(me.clientX, me.clientY);
      },
      accept: (me) => {
        if (this.state) {
          const t = resolveTargetAt(me.clientX, me.clientY);
          if (t) this.commit(t);
        }
        // A real drag happened → swallow the synthetic click that follows so it
        // doesn't re-select / re-enter connect mode on the element it lands on.
        // The trailing click (if any) dispatches before this macrotask; the
        // timeout clears the flag if no click fires so a later click isn't eaten.
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
    this.state = s;
  }

  private installClickListeners() {
    if (this.clickListenersActive) return;
    this.clickListenersActive = true;
    // Defer so the click that began the gesture doesn't immediately cancel it.
    setTimeout(() => {
      if (!this.state) return;
      document.addEventListener('pointermove', this.onDocMove);
      document.addEventListener('pointerdown', this.onDocDown);
      document.addEventListener('keydown', this.onDocKey);
    }, 0);
  }

  // --- Pointer / highlight ---

  private updatePointer(x: number, y: number) {
    if (!this.state) return;
    this.state.pointerX = x;
    this.state.pointerY = y;
    const el = deepElementFromPoint(x, y);
    const drop = (el?.closest?.('.tap-overlay-hit') ?? el?.closest?.('.badge')) as HTMLElement | null;
    if (drop === this.lastDropEl) return;
    this.lastDropEl?.removeAttribute('tap-drop-target');
    this.lastDropEl?.removeAttribute('drop-target');
    if (drop) drop.setAttribute(drop.classList.contains('badge') ? 'drop-target' : 'tap-drop-target', '');
    this.lastDropEl = drop;
  }

  // --- Completes (called from element handlers) ---

  completeOnField(key: string) {
    if (!this.state) return;
    const t = this.fieldTargetByKey(key);
    if (t) this.commit(t);
    this.end();
  }

  completeOnRail(railId: string) {
    if (!this.state) return;
    this.commit({ kind: 'rail', railId });
    this.end();
  }

  completeOnNewRail() {
    if (!this.state) return;
    this.commit({ kind: 'new' });
    this.end();
  }

  private fieldTargetByKey(key: string): Target | null {
    // Build the target straight from app state — the hit elements live inside
    // nested shadow roots that a document query can't reach. Output bit = io&2.
    const [sketchId, colStr, chainStr, ...fp] = key.split('/');
    const colIdx = +colStr, chainIdx = +chainStr;
    const fieldPath = fp.join('/');
    const entry = appState.database.sketches[sketchId]?.columns[colIdx]?.chain[chainIdx];
    if (entry?.type !== 'module') return null;
    const schemaDef = appState.local.plugins.find(p => p.id === entry.module_type)?.schema?.[fieldPath] ?? null;
    const info: FieldConnectInfo = {
      sketchId, colIdx, chainIdx, fieldPath,
      isOutput: !!(((schemaDef as any)?.io ?? 0) & 2),
      viewportY: this.state?.pointerY ?? 0, // pointer is over the target → good Y for same-dir
      schemaDef,
    };
    return { kind: 'field', key, info };
  }

  // --- Commit ---

  private commit(target: Target) {
    const s = this.state;
    if (!s) return;
    if (s.sourceKind === 'field') {
      const info = s.info!;
      if (target.kind === 'field') {
        appController.connectFields(info, target.info);
      } else if (target.kind === 'rail') {
        appController.connectFieldToRail(info, target.railId);
      } else {
        // New rail + tap, scoped/typed from the source field.
        if (info.isOutput) {
          appController.autoCreateTapForOutputField(
            info.sketchId, info.colIdx, info.chainIdx, info.fieldPath, info.schemaDef);
        } else {
          appController.autoCreateTapForInputField(
            info.sketchId, info.colIdx, info.chainIdx, info.fieldPath, info.schemaDef);
        }
      }
    } else {
      // Rail source → only a field target makes sense.
      if (target.kind === 'field') {
        appController.connectFieldToRail(target.info, s.sourceId);
      }
    }
  }

  cancel() { this.end(); }

  private end() {
    this.state = null;
    this.lastDropEl?.removeAttribute('tap-drop-target');
    this.lastDropEl?.removeAttribute('drop-target');
    this.lastDropEl = null;
    if (this.clickListenersActive) {
      this.clickListenersActive = false;
      document.removeEventListener('pointermove', this.onDocMove);
      document.removeEventListener('pointerdown', this.onDocDown);
      document.removeEventListener('keydown', this.onDocKey);
    }
  }
}

/** Shared singleton. */
export const tapsConnect = new TapsConnect();
