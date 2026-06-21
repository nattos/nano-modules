/**
 * FrameSource — uniform interface for codec-backed video sources.
 *
 * The playback service treats every clip as a FrameSource: "decode frame
 * N into this texture, here are your dimensions." Different codecs
 * (DXV today, WebCodecs h264/etc. tomorrow) implement this surface so
 * the service's cache + classifier + scheduler stay codec-agnostic.
 */

export interface FrameSource {
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  /** Native frame rate. Consumers (e.g. the IDE's loop playhead) MUST
   *  drive playback at this rate: requesting frames faster than a
   *  <video>-backed source can play makes it drift ahead, forcing
   *  mid-GOP seeks that return black on sparse-keyframe clips. */
  readonly fps: number;
  /** GPUHost format code (see `textureFormatFromCode` in gpu-host.ts).
   *  Used by the cache to size each entry. 1 = rgba8unorm. */
  readonly formatCode: number;
  /** Codec identifier for telemetry / hints (e.g. "DXV3-DXT1", "h264"). */
  readonly codec: string;
  /** True for play-forward-only sources (a <video> element) where frames
   *  must be sampled live in playback order — random access is unreliable
   *  (mid-GOP seeks return black on sparse-keyframe clips). The service
   *  bypasses its cache + read-ahead for these and samples the current
   *  frame; `decode(idx)` ignores `idx` (the element's own clock drives
   *  which frame is current). False for random-access codecs (DXV). */
  readonly streaming: boolean;

  /** Decode frame `idx` into the GPUHost texture handle `outTexHandle`.
   *  Resolves when the texture is ready to sample. */
  decode(idx: number, outTexHandle: number): Promise<void>;

  /** Live (streaming) sources only: play or pause the underlying element.
   *  Streaming sources are driven by the element's own clock (decode()
   *  samples the current frame), so a consumer that wants to freeze the
   *  preview on pause must stop the element here — otherwise it drifts
   *  ahead while "paused" and jumps on resume. No-op / absent for
   *  random-access sources (DXV), which are driven purely by decode(idx). */
  setPlaying?(playing: boolean): void;

  /** Live (streaming) sources only: advance the element by ~one frame
   *  while paused (a short forward seek the decoder serves from its
   *  current position), so a paused frame-step still moves the video in
   *  lock-step with the engine. Absent for random-access sources, which
   *  step by requesting the next frame index directly. */
  stepForward?(): Promise<void>;

  /** Release codec-side resources. The host releases textures separately
   *  via the FrameCache. */
  dispose(): void;
}
