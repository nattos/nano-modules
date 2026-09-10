/**
 * One pointer drag that is GUARANTEED to end.
 *
 * The failure mode this exists to kill: a gesture wired as bare
 * `window.addEventListener('pointermove'/'pointerup')` never hears about a
 * release that happens outside the browser window, and never hears about a
 * `pointercancel` at all. Either one leaves the drag armed — the clip keeps
 * following the cursor when you come back, an undo gesture stays open, a
 * splitter keeps resizing — until some unrelated click happens to release it.
 *
 * Two rules fix that, and they are the whole of this module:
 *
 *  1. CAPTURE the pointer on a stable element. Capture is what makes the browser
 *     deliver the pointerup even when the button comes up over another window,
 *     and it keeps the move stream coming when the cursor leaves the element the
 *     gesture started on.
 *  2. Treat `pointercancel` exactly like a release, and make `end` run EXACTLY
 *     ONCE however the gesture finished — released, cancelled, or stopped by the
 *     owner (`stop()`, e.g. on disconnect).
 *
 * The capture element must OUTLIVE the drag: pass the surface that owns the
 * gesture (the grid, the lane, the clip) rather than whatever the pointer
 * happened to land on, since a re-render can replace the latter mid-drag —
 * losing capture and, with it, the pointerup.
 */

export interface DragGestureOpts {
  /**
   * Element to capture the pointer on. Defaults to the event's `currentTarget`
   * (else its `target`) — fine for a splitter, wrong for anything whose target
   * can be re-rendered mid-drag.
   */
  capture?: Element | null;
  /**
   * Movement (px from pointer-down) at which the pointer is captured. Capture is
   * deliberately LAZY: it retargets the trailing compatibility mouse events too,
   * so capturing on pointer-down would send the `click`/`dblclick` of a mere
   * click to the capture element instead of what was actually clicked. Waiting
   * for real movement means a click stays a click and a drag gets its guarantee.
   * Default matches the surfaces' own drag thresholds.
   */
  captureAfterPx?: number;
  move?: (e: PointerEvent) => void;
  /**
   * Runs exactly once, when the drag ends. `cancelled` is true when it ended by
   * `pointercancel` or by the owner calling `stop()`, false on a real release.
   * `e` is null when there was no terminating pointer event.
   */
  end?: (e: PointerEvent | null, cancelled: boolean) => void;
}

/** Movement (px) that turns a press into a drag — and so takes the capture. */
const DEFAULT_CAPTURE_PX = 4;

export interface DragGesture {
  /** End the gesture now (default: as a cancel). Safe to call twice. */
  stop(cancelled?: boolean): void;
  readonly active: boolean;
}

export function beginDragGesture(down: PointerEvent, opts: DragGestureOpts = {}): DragGesture {
  const id = down.pointerId;
  const captureEl = opts.capture
    ?? (down.currentTarget as Element | null)
    ?? (down.target as Element | null);
  const captureAfter = opts.captureAfterPx ?? DEFAULT_CAPTURE_PX;
  const x0 = down.clientX;
  const y0 = down.clientY;
  let captured = false;
  let done = false;

  const captureIfDragging = (e: PointerEvent) => {
    if (captured) return;
    if (Math.hypot(e.clientX - x0, e.clientY - y0) < captureAfter) return;
    captured = true;
    // Capture can legitimately fail (the element is detached). The gesture still
    // works off the window listeners; it just loses the out-of-window release
    // guarantee, which is no worse than not trying.
    try { captureEl?.setPointerCapture(id); } catch { /* not capturable */ }
  };

  const finish = (e: PointerEvent | null, cancelled: boolean) => {
    if (done) return;
    done = true;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    // hasPointerCapture first: releasing a pointer that is no longer active
    // throws, and that would skip whatever the caller does in `end`.
    try {
      if (captureEl?.hasPointerCapture(id)) captureEl.releasePointerCapture(id);
    } catch { /* already gone */ }
    opts.end?.(e, cancelled);
  };

  const onMove = (e: PointerEvent) => {
    if (done || e.pointerId !== id) return;
    captureIfDragging(e);
    opts.move?.(e);
  };
  const onUp = (e: PointerEvent) => { if (e.pointerId === id) finish(e, false); };
  const onCancel = (e: PointerEvent) => { if (e.pointerId === id) finish(e, true); };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);

  return {
    stop: (cancelled = true) => finish(null, cancelled),
    get active() { return !done; },
  };
}
