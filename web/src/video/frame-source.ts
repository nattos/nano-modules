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

  /** Release codec-side resources. The host releases textures separately
   *  via the FrameCache. */
  dispose(): void;
}
