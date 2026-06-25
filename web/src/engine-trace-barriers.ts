/**
 * engine-trace-barriers.ts — pure derivation of the fusion-barrier set from the
 * active trace points.
 *
 * The executor fuses consecutive point-op effects into one GPU kernel; only the
 * first stage's INPUT and the last stage's OUTPUT of a fused group land in real
 * textures. A preview monitor that needs an intermediate texture asks the planner
 * to split the group there by marking a chain entry as a "barrier" (native
 * `is_barrier`). The rule:
 *
 *  - An OUTPUT preview of entry N barriers N itself (ending its group AT N →
 *    N's output materialises).
 *  - An INPUT preview of entry N must instead barrier N-1 (ending the previous
 *    group there → N-1's output, i.e. N's input, materialises). N=0 has no
 *    predecessor; its input is the chain's external/injected input, never fused.
 *
 * Kept pure (no executor / worker globals) so the invariant that matters most —
 * "no chain_entry trace ⇒ no barrier ⇒ full fusion" — is unit-testable.
 */

import type { TracePoint } from './engine-types';

/**
 * The set of `"<sketchId>/<colIdx>/<chainIdx>"` keys the planner should treat as
 * fusion barriers for this frame's trace points. Empty when nothing is traced.
 */
export function traceBarrierKeys(tracePoints: readonly TracePoint[]): Set<string> {
  const keys = new Set<string>();
  for (const tp of tracePoints) {
    if (tp.target.type !== 'chain_entry') continue;
    const { sketchId, colIdx, chainIdx, side } = tp.target;
    // INPUT preview → barrier the predecessor; OUTPUT preview → barrier the entry.
    const barrierIdx = side === 'input' ? chainIdx - 1 : chainIdx;
    if (barrierIdx >= 0) keys.add(`${sketchId}/${colIdx}/${barrierIdx}`);
  }
  return keys;
}
