import { runGpuEffectTest, forEachBackend } from './gpu-test-helpers';

// Per-effect tests for `motion.frame_delay` against `core`.
//
// The delay's TIMING (which frame comes back out, how the ring fills, and the
// memory discipline as the delay grows and shrinks) is pinned natively, in
// test_effect_render.cpp — this harness feeds a constant colour every frame, so
// it can't tell frame N from frame N-3 by pixel value.
//
// What it CAN tell — and what's worth pinning on both backends — is that the
// effect's texture-copy path works at all. The effect ships no shader: it leans
// entirely on gpu::Device::copy for both the capture and the replay. That path
// goes through different machinery on Metal and WebGPU, and if either end of it
// were broken the output would come back black or transparent rather than
// carrying the image.
forEachBackend((backend) => {
  describe(`Frame Delay Effect E2E (${backend})`, () => {
    jest.setTimeout(30000);

    const INPUT: [number, number, number, number] = [0.8, 0.4, 0.2, 1.0];
    const EXPECT = { r: 204, g: 102, b: 51, a: 255 };

    it('declares metadata', async () => {
      const frame = await runGpuEffectTest({
        module: 'motion.frame_delay',
        bundle: 'core',
        inputColor: INPUT,
        dumpName: 'frame_delay_metadata',
      });

      expect(frame.success).toBe(true);
      expect(frame.metadata?.id).toBe('motion.frame_delay');
    });

    it('passes the image through while the ring is still filling', async () => {
      // Delay 5, but only 2 frames rendered: the ring has no frame that old yet.
      // The contract is to show the LIVE image, not black — a dropped-in delay
      // that blanks the output for half a second reads as a broken effect.
      const frame = await runGpuEffectTest({
        module: 'motion.frame_delay',
        bundle: 'core',
        inputColor: INPUT,
        params: [['delay', 5]],
        ticks: 2,
        renderEachTick: true,
        dumpName: 'frame_delay_filling',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, EXPECT, 4);
    });

    it('replays a captured frame once the ring is full', async () => {
      // 8 renders at delay 3: the ring is full, so this output came out of the
      // history rather than straight off the input. Same colour (every frame is
      // the same), but it made the round trip through gpu::Device::copy twice.
      const frame = await runGpuEffectTest({
        module: 'motion.frame_delay',
        bundle: 'core',
        inputColor: INPUT,
        params: [['delay', 3]],
        ticks: 8,
        renderEachTick: true,
        dumpName: 'frame_delay_full',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, EXPECT, 4);
    });

    it('holds the full 30-frame ring without falling over', async () => {
      // The maximum. 31 viewport-sized textures — the case where a leak or a
      // failed allocation would actually hurt.
      const frame = await runGpuEffectTest({
        module: 'motion.frame_delay',
        bundle: 'core',
        inputColor: INPUT,
        params: [['delay', 30]],
        ticks: 34,
        renderEachTick: true,
        dumpName: 'frame_delay_max',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, EXPECT, 4);
    });
  });
});
