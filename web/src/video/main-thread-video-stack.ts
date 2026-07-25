/**
 * Shared main-thread GPU video-decode stack.
 *
 * The engine's render device lives in a worker, so main-thread video previews
 * (the IDE's per-sketch `texture_input`, and the offline/playground global
 * "test input") decode on their OWN main-thread device and hand each frame to
 * the worker as an `ImageBitmap`. Both consumers share ONE stack — a second
 * WebGPU device per consumer would be wasteful and can trip adapter limits.
 *
 * Created lazily on first video load; the same promise is reused thereafter.
 */

import { GPUHost } from '../gpu-host';
import { VideoPlaybackService } from './playback-service';
import { FrameBlitter } from './frame-blitter';
import { requestStandardDevice } from '../webgpu-device';

export interface MainThreadVideoStack {
  service: VideoPlaybackService;
  gpuHost: GPUHost;
  blitter: FrameBlitter;
}

let stackPromise: Promise<MainThreadVideoStack> | null = null;

export function getMainThreadVideoStack(): Promise<MainThreadVideoStack> {
  if (stackPromise) return stackPromise;
  stackPromise = (async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter for video playback');
    // texture-compression-bc: DXV's BC1 fast path needs it; harmless when the
    // host lacks it (only the DXV codec is then unavailable — <video> formats
    // still work).
    const device = await requestStandardDevice(adapter, ['texture-compression-bc']);
    const gpuHost = new GPUHost(device, 'rgba8unorm');
    const blitter = new FrameBlitter(device);
    // Absolute path: the dev server (and the built app) serve /wasm/ at the
    // root regardless of which page loaded the module.
    const service = new VideoPlaybackService(gpuHost, { dxvWasmUrl: '/wasm/dxv_decoder.wasm' });
    return { service, gpuHost, blitter };
  })();
  return stackPromise;
}
