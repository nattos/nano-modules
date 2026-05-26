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
  /** GPUHost format code (see `textureFormatFromCode` in gpu-host.ts).
   *  Used by the cache to size each entry. 1 = rgba8unorm. */
  readonly formatCode: number;
  /** Codec identifier for telemetry / hints (e.g. "DXV3-DXT1", "h264"). */
  readonly codec: string;

  /** Decode frame `idx` into the GPUHost texture handle `outTexHandle`.
   *  Resolves when the texture is ready to sample. */
  decode(idx: number, outTexHandle: number): Promise<void>;

  /** Release codec-side resources. The host releases textures separately
   *  via the FrameCache. */
  dispose(): void;
}
