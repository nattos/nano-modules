import { describe, it, expect, vi } from 'vitest';
import { dragHasFiles, claimDrop } from './drag-drop';

function fakeDrag(types: string[] | null): DragEvent {
  return {
    dataTransfer: types === null ? null : { types },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as DragEvent;
}

describe('drag-drop helpers', () => {
  it('dragHasFiles detects an OS-file drag vs. other drags', () => {
    expect(dragHasFiles(fakeDrag(['Files']))).toBe(true);
    expect(dragHasFiles(fakeDrag(['text/plain', 'Files']))).toBe(true);
    expect(dragHasFiles(fakeDrag(['text/plain']))).toBe(false);
    expect(dragHasFiles(fakeDrag([]))).toBe(false);
    expect(dragHasFiles(fakeDrag(null))).toBe(false);
  });

  it('claimDrop overrides the page fallback (preventDefault + stopPropagation)', () => {
    const e = fakeDrag(['Files']);
    claimDrop(e);
    // stopPropagation is what keeps the composed event from reaching the
    // IDE host listener, letting a specific zone own the drop.
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
