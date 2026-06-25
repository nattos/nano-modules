/**
 * Pure decision logic for the arrangement monitor's "Precise" transport gate.
 *
 * Precise mode must NEVER composite a frame that isn't fully possible per the timeline
 * — no layer beneath an unready video flashing through, no stale frame. The orchestration
 * (issuing the composite, the decode pump, retained frames) lives in
 * `engine-bridge.showComposite`; the *decisions* are extracted here so the invariants
 * are unit-tested — each one had a bug that flashed. See memory: precise-transport-gate.
 */

/** Minimal shape the gate needs from an active video-clip descriptor. */
export interface GateClip {
  clipId: string;
}

/**
 * Are all the ACTIVE video clips ready to composite?
 *  - no video clips                         ⇒ ready (nothing to wait on)
 *  - video clips present but no decode pump  ⇒ NOT ready (a fresh-page landing must hold,
 *    not composite the video transparent — the pump is created lazily)
 *  - otherwise                              ⇒ every clip's current frame must be injected
 */
export function videoInputsReady(
  active: readonly GateClip[],
  hasPump: boolean,
  isClipReady: (clipId: string) => boolean,
): boolean {
  if (active.length === 0) return true;
  if (!hasPump) return false;
  return active.every((c) => isClipReady(c.clipId));
}

/**
 * Should Precise mode HOLD the displayed composite this frame? Only in precise mode,
 * with at least one active video clip that isn't ready, and not `force`d (the fail-safe
 * timeout bypass that prevents a genuinely-stuck decode from freezing forever).
 */
export function shouldHoldPrecise(opts: {
  precise: boolean;
  force: boolean;
  activeVideoCount: number;
  ready: boolean;
}): boolean {
  return !opts.force && opts.precise && opts.activeVideoCount > 0 && !opts.ready;
}

/**
 * The decode pump's active set for a frame. While HOLDING, the clips CURRENTLY ON SCREEN
 * (`displayed`) are kept alive alongside the `target` (active + lookahead) so the held
 * frame's textures aren't torn down (a transparent flash); on commit only the target
 * remains (old clips drop after the new composite is issued). Union by clipId; `target`
 * wins on conflict (it carries the current desc).
 */
export function pumpActiveSet<T extends GateClip>(
  holding: boolean,
  target: readonly T[],
  displayed: readonly T[],
): T[] {
  if (!holding) return [...target];
  const byId = new Map<string, T>();
  for (const d of displayed) byId.set(d.clipId, d);
  for (const d of target) byId.set(d.clipId, d);
  return [...byId.values()];
}
