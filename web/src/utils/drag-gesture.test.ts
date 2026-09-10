// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { beginDragGesture } from './drag-gesture';

/** jsdom has no PointerEvent; the helper only reads these three fields. */
function pointer(type: string, x = 0, y = 0, pointerId = 7): PointerEvent {
  const e = new Event(type, { bubbles: true }) as unknown as {
    pointerId: number; clientX: number; clientY: number;
  };
  e.pointerId = pointerId;
  e.clientX = x;
  e.clientY = y;
  return e as unknown as PointerEvent;
}

function fakeCaptureTarget() {
  let held = false;
  return {
    el: {
      setPointerCapture: vi.fn(() => { held = true; }),
      releasePointerCapture: vi.fn(() => { held = false; }),
      hasPointerCapture: vi.fn(() => held),
    } as unknown as Element,
    get held() { return held; },
  };
}

describe('beginDragGesture', () => {
  it('ends on pointerup and stops listening', () => {
    const t = fakeCaptureTarget();
    const move = vi.fn();
    const end = vi.fn();
    beginDragGesture(pointer('pointerdown'), { capture: t.el, move, end });

    window.dispatchEvent(pointer('pointermove', 30, 0));
    expect(move).toHaveBeenCalledTimes(1);

    window.dispatchEvent(pointer('pointerup', 30, 0));
    expect(end).toHaveBeenCalledWith(expect.anything(), false);

    // Nothing survives the end.
    window.dispatchEvent(pointer('pointermove', 60, 0));
    expect(move).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('ends on pointercancel — the case the old hand-rolled drags never heard', () => {
    const t = fakeCaptureTarget();
    const end = vi.fn();
    const move = vi.fn();
    beginDragGesture(pointer('pointerdown'), { capture: t.el, move, end });
    window.dispatchEvent(pointer('pointermove', 30, 0));
    window.dispatchEvent(pointer('pointercancel', 30, 0));
    expect(end).toHaveBeenCalledWith(expect.anything(), true);
    window.dispatchEvent(pointer('pointermove', 60, 0));
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('captures the pointer once the press becomes a drag, and releases it', () => {
    const t = fakeCaptureTarget();
    beginDragGesture(pointer('pointerdown', 100, 100), { capture: t.el });

    // A press that never really moves stays uncaptured, so its click/dblclick
    // still reach whatever was actually clicked.
    window.dispatchEvent(pointer('pointermove', 101, 101));
    expect(t.el.setPointerCapture).not.toHaveBeenCalled();

    window.dispatchEvent(pointer('pointermove', 120, 100));
    expect(t.el.setPointerCapture).toHaveBeenCalledWith(7);

    window.dispatchEvent(pointer('pointerup', 120, 100));
    expect(t.el.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(t.held).toBe(false);
  });

  it('ignores events from a different pointer', () => {
    const move = vi.fn();
    const end = vi.fn();
    beginDragGesture(pointer('pointerdown', 0, 0, 1), { capture: null, move, end });
    window.dispatchEvent(pointer('pointermove', 50, 0, 2));
    window.dispatchEvent(pointer('pointerup', 50, 0, 2));
    expect(move).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    window.dispatchEvent(pointer('pointerup', 50, 0, 1));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('stop() ends it as a cancel, exactly once', () => {
    const end = vi.fn();
    const g = beginDragGesture(pointer('pointerdown'), { capture: null, end });
    expect(g.active).toBe(true);
    g.stop();
    g.stop();
    window.dispatchEvent(pointer('pointerup'));
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(null, true);
    expect(g.active).toBe(false);
  });

  it('survives a capture target that refuses the pointer', () => {
    const el = {
      setPointerCapture: () => { throw new Error('detached'); },
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => false,
    } as unknown as Element;
    const move = vi.fn();
    const end = vi.fn();
    beginDragGesture(pointer('pointerdown'), { capture: el, move, end });
    window.dispatchEvent(pointer('pointermove', 40, 0));
    window.dispatchEvent(pointer('pointerup', 40, 0));
    expect(move).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
