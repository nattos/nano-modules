/**
 * offline-eval-worker.ts — runs the rail curve's offline block evaluation OFF the
 * main thread AND off the composition (executor) thread, so neither stalls while a
 * return's curve is (re)computed. Pure math in `offline-curve-eval`; this is just
 * the message pump. Results post back as transferable Float32Arrays.
 */

import { assembleRailCurve, type RailCurveSpec } from './offline-curve-eval';

interface ReqMsg { reqId: number; railId: string; spec: RailCurveSpec }

self.onmessage = (e: MessageEvent<ReqMsg>) => {
  const { reqId, railId, spec } = e.data;
  const curve = assembleRailCurve(spec);
  (self as unknown as Worker).postMessage(
    { reqId, railId, mean: curve.mean, lo: curve.lo, hi: curve.hi },
    [curve.mean.buffer, curve.lo.buffer, curve.hi.buffer],
  );
};
