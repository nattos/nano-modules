import { describe, it, expect } from 'vitest';
import { VideoCompositor } from './video-compositor';

/**
 * clipReady is the signal the Precise transport gate uses to avoid compositing /
 * stepping before a video input is decoded. With per-clip cursors it delegates to the
 * cursor's own `ready(targetSec)` (is the right frame presented?) — except off-slice,
 * where transparent IS a valid ready state.
 */
function makeVC() {
  return new VideoCompositor(() => {}, 640, 360, () => ({ beat: 0, bpm: 120 }));
}

describe('VideoCompositor.clipReady', () => {
  it('false while opening / without a pump; delegates to the cursor; off-slice is ready', () => {
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

    // A pump with a (looping) slice in range → clipReady delegates to the cursor.
    let cursorReady = false;
    const pump = {
      desc: {
        clipId: 'c', startBeat: 8, lengthBeat: 8, scaleMode: 'fit',
        loop: { mode: 'time', startSec: 0, endSec: 10, speed: 1, direction: 'forward' },
      },
      fps: 30, frameCount: 300, durationSec: 10,
      cursor: { ready: () => cursorReady },
    };
    internal.pumps.set('c', pump);
    expect(vc.clipReady('c', 8, 120)).toBe(false); // cursor not ready yet
    cursorReady = true;
    expect(vc.clipReady('c', 8, 120)).toBe(true); // cursor reports the frame is presented

    // A ONE-SHOT slice queried past the source end → targetSec is null → transparent is a
    // valid "ready" (the gate barrels past), regardless of the cursor.
    pump.desc.loop = { mode: 'one-shot', startSec: 0, speed: 1, direction: 'forward' } as never;
    cursorReady = false;
    expect(vc.clipReady('c', 100, 120)).toBe(true);
  });
});
