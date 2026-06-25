import { describe, it, expect } from 'vitest';
import { VideoCompositor } from './video-compositor';

/**
 * clipReady is the signal the Precise transport gate uses to avoid compositing /
 * stepping before a video input is decoded. A clip is ready only once the frame
 * for the queried beat has been injected (pump.lastKey matches).
 */
function makeVC() {
  return new VideoCompositor(() => {}, 640, 360, () => ({ beat: 0, bpm: 120 }));
}

describe('VideoCompositor.clipReady', () => {
  it('is false while opening, false without a pump, true once the frame is injected', () => {
    const vc = makeVC();
    const internal = vc as unknown as {
      opening: Set<string>;
      pumps: Map<string, unknown>;
    };

    // Still opening → not ready.
    internal.opening.add('c');
    expect(vc.clipReady('c', 8, 120)).toBe(false);
    internal.opening.delete('c');

    // No pump yet → not ready.
    expect(vc.clipReady('c', 8, 120)).toBe(false);

    // A pump whose lastKey does NOT match the queried beat's frame → not ready.
    const pump = {
      desc: { clipId: 'c', startBeat: 8, lengthBeat: 8, scaleMode: 'fit' },
      fps: 30,
      frameCount: 300,
      lastKey: undefined as string | undefined,
    };
    internal.pumps.set('c', pump);
    expect(vc.clipReady('c', 8, 120)).toBe(false); // frame 0 at beat 8, but nothing injected

    // Inject the matching frame (beat 8 → local frame 0). The key folds in the
    // identity placement transform (anchor .5,.5 / scale 1 / rot 0 / no flip).
    pump.lastKey = '0:fit:0.5,0.5,1,0,00:640x360';
    expect(vc.clipReady('c', 8, 120)).toBe(true);

    // A different beat needs a different frame → not ready until re-injected.
    expect(vc.clipReady('c', 12, 120)).toBe(false);
  });
});
