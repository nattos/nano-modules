/**
 * Where a new effect goes when the user doesn't say: right after the first
 * selected card of the linear list, else at the end of the linear list —
 * never past it, or the insert would land among the tail-partitioned sidecar
 * canvas entries. Shared by the insert chips (column-group) and the effect
 * store's "insert into the current sketch".
 */

import { isCanvasEntry, linearChainLength, sketchChain, type Sketch } from '../sketch-types';

export function defaultInsertIndex(
  sketch: Sketch | undefined,
  sketchId: string,
  colIdx: number,
  isSelected: (path: string) => boolean,
): number {
  if (!sketch) return 0;
  const chain = sketchChain(sketch);
  for (let i = 0; i < chain.length; i++) {
    if (isCanvasEntry(chain[i])) continue;
    if (isSelected(`effect/${sketchId}/${colIdx}/${i}`)) return i + 1;
  }
  return linearChainLength(sketch);
}
