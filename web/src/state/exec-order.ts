/**
 * Merged execution order for a sketch — the topological sort that lets the
 * sidecar canvas interleave with the linear effect list.
 *
 * The linear list is a strict sequence (it IS the pixel path, and its order is
 * what the user arranged). Canvas nodes have no inherent order — only the wires
 * between them say what must run first. So the order is a topo-sort in which
 * linear adjacency is a HARD constraint and every wire is a SOFT one: wires that
 * can be honored reorder the graph, wires that can't become one-frame-delayed
 * (which is also how feedback loops are broken — see `Sketch.wires`).
 *
 * The result is stored on the sketch (`Sketch.execOrder`) and the executor
 * consumes it directly, so this file is the ONLY place the order is decided.
 * The executor never topo-sorts; it just repairs and replays (`repairExecOrder`,
 * mirrored natively as `sketch_canvas::resolveExecOrder`).
 *
 * Pure: no MobX, no DOM, no appState. Called EXPLICITLY from the controller
 * recipes that change the chain or the wires — never from a reaction.
 */

import {
  type Sketch,
  isCanvasEntry, repairExecOrder, sketchChain,
} from '../sketch-types';
import { isMidiInstanceKey } from '../midi/midi-types';

/**
 * The merged execution order, as `instance_key`s.
 *
 * Kahn's algorithm with a deterministic tie-break:
 * - HARD edges join consecutive LINEAR entries (`L_i → L_i+1`). Only consecutive
 *   pairs — transitivity covers the rest and the edge count stays linear.
 * - SOFT edges come from wires (`src → dest`). `midi:` sources live outside the
 *   chain and impose no ordering; self-wires are inherently feedback.
 * - Among ready nodes the smallest tie-break key wins: linear entries sort
 *   before canvas entries, each by its own index. This makes the sort degenerate
 *   to EXACTLY chain order when no wire crosses the partition — which is what
 *   lets `Sketch.execOrder` be omitted from ordinary sketches.
 * - When nothing is ready but nodes remain, a cycle exists. Force-emit the
 *   smallest-key node that has no pending HARD predecessor and drop its pending
 *   SOFT incoming edges; those wires become the delayed/feedback ones. Such a
 *   node always exists (canvas nodes never have hard predecessors, and the
 *   first remaining linear node's hard predecessor has already been emitted), so
 *   this terminates and can never violate linear order.
 *
 * Fully determined by `(chain, wires)` — never by wire iteration order,
 * insertion time or the clock — so two clients on one document agree.
 */
export function computeExecOrder(sketch: Sketch): string[] {
  const chain = sketchChain(sketch);
  const n = chain.length;
  if (n === 0) return [];

  // First occurrence wins if a document somehow carries duplicate keys; the
  // duplicate is then unreachable as an edge endpoint but still gets emitted.
  const idxByKey = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (!idxByKey.has(chain[i].instance_key)) idxByKey.set(chain[i].instance_key, i);
  }

  // Tie-break key: linear entries first (by linear index), then canvas entries
  // (by chain index). Both sequences are already ascending in chain order, so
  // the plain chain index would do — but spelling it out keeps the rule true if
  // the tail-partition invariant is ever relaxed.
  const rank = new Int32Array(n);
  let linearSeen = 0;
  for (let i = 0; i < n; i++) {
    rank[i] = isCanvasEntry(chain[i]) ? n + i : linearSeen++;
  }

  const outHard: number[][] = Array.from({ length: n }, () => []);
  const outSoft: number[][] = Array.from({ length: n }, () => []);
  const indegHard = new Int32Array(n);
  const indegSoft = new Int32Array(n);

  let prevLinear = -1;
  for (let i = 0; i < n; i++) {
    if (isCanvasEntry(chain[i])) continue;
    if (prevLinear >= 0) { outHard[prevLinear].push(i); indegHard[i]++; }
    prevLinear = i;
  }

  const softSeen = new Set<number>();
  for (const w of sketch.wires ?? []) {
    if (!w?.src || !w?.dest) continue;
    if (isMidiInstanceKey(w.src.instanceKey)) continue;   // external: imposes no order
    const a = idxByKey.get(w.src.instanceKey);
    const b = idxByKey.get(w.dest.instanceKey);
    if (a === undefined || b === undefined || a === b) continue;
    const edge = a * n + b;
    if (softSeen.has(edge)) continue;                     // parallel wires = one constraint
    softSeen.add(edge);
    outSoft[a].push(b);
    indegSoft[b]++;
  }

  const emitted = new Uint8Array(n);
  const out: string[] = [];

  const release = (i: number) => {
    for (const j of outHard[i]) indegHard[j]--;
    for (const j of outSoft[i]) indegSoft[j]--;
  };

  for (let step = 0; step < n; step++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (emitted[i] || indegHard[i] !== 0 || indegSoft[i] !== 0) continue;
      if (pick < 0 || rank[i] < rank[pick]) pick = i;
    }
    if (pick < 0) {
      // Cycle. Force the smallest-key node with no pending HARD predecessor and
      // cut its pending soft edges — those wires read last frame's value.
      for (let i = 0; i < n; i++) {
        if (emitted[i] || indegHard[i] !== 0) continue;
        if (pick < 0 || rank[i] < rank[pick]) pick = i;
      }
      if (pick < 0) break;   // unreachable: hard edges form a simple path
      indegSoft[pick] = 0;   // later release() may drive it negative; pick is emitted
    }
    emitted[pick] = 1;
    out.push(chain[pick].instance_key);
    release(pick);
  }

  // Defensive: emit anything the loop somehow missed, in chain order, so the
  // result is always a total order over the chain.
  for (let i = 0; i < n; i++) if (!emitted[i]) out.push(chain[i].instance_key);
  return out;
}

/**
 * Execution rank per `instance_key`, derived from the sketch's STORED order
 * (repaired), not from a fresh sort.
 *
 * This is what causality must be read from: a wire is delayed when
 * `pos(src) >= pos(dest)`. Reading the stored order — the same thing the
 * executor replays — is what keeps the UI's delayed markers honest even if the
 * stored order is momentarily behind an edit. The native twin of this rule lives
 * at the `delayed` computation in native/src/sketch/sketch_executor.cpp; keep
 * them in lock-step.
 */
export function execPositions(sketch: Sketch): Map<string, number> {
  const order = resolvedExecOrder(sketch);
  const pos = new Map<string, number>();
  for (let i = 0; i < order.length; i++) pos.set(order[i], i);
  return pos;
}

/** The order the executor will actually run: stored, repaired against the chain. */
export function resolvedExecOrder(sketch: Sketch): string[] {
  return repairExecOrder(sketchChain(sketch), sketch.execOrder);
}

/** Whether a wire reads last frame's value under `pos` (also how cycles break). */
export function wireIsDelayed(
    pos: Map<string, number>, srcKey: string, destKey: string): boolean {
  const sp = pos.get(srcKey);
  const dp = pos.get(destKey);
  if (sp === undefined || dp === undefined) return false;
  return sp >= dp;
}
