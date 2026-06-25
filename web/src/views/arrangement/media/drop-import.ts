/**
 * Import a dropped file as a clip source: an object URL + a stable `sourceKey` +
 * a probed duration/frame estimate, so the clip spans its real length on the beat
 * grid and the film strip can decode thumbnails. IMAGES masquerade as a 1-frame,
 * 1-second source (the cache/pump treat them like a still video). Best-effort —
 * a non-decodable file still becomes a clip with a default length.
 */

export interface DroppedMedia {
  sourceKey: string;
  url: string;
  frameCount: number;
  fps: number;
  label: string;
  durationSec: number;
  /** Native pixel dimensions (0 if unknown) — drives the placement widget's aspect. */
  width: number;
  height: number;
}

const ASSUMED_FPS = 30;
const DEFAULT_DURATION = 4;
/** Default on-timeline length for a dropped still image. */
const IMAGE_DURATION = 1;
/** Still-image extensions — a fallback when the dropped File has no MIME type
 *  (FileSystem-handle drops on Chrome frequently report an empty `type`). Without
 *  this an extension-only PNG misroutes to the <video> probe → 0×0 dimensions. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?|heic)$/i;

/** A dropped file is a still image if its MIME type says so OR (when the type is
 *  absent/wrong, as FileSystem-handle drops often are) its extension does. */
export function isImageFile(file: { type: string; name: string }): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

/**
 * @param sourceKey  Caller-provided stable key. When the file came from a
 *   FileSystemFileHandle, pass the `linkMedia()` key so the source can be
 *   relinked after reload; otherwise a session-only `drop:` key is derived.
 */
export async function importVideoFile(file: File, sourceKey?: string): Promise<DroppedMedia> {
  const url = URL.createObjectURL(file);
  sourceKey ??= `drop:${file.name}:${file.size}:${file.lastModified}`;

  // A still image is a one-frame, one-second source — probe its pixel size too.
  // Detect by MIME type OR extension (an empty `type` would otherwise misroute a
  // PNG to the <video> probe, which fails → 0×0 → the placement widget loses aspect).
  if (isImageFile(file)) {
    const dim = await probeImageSize(url).catch(() => ({ width: 0, height: 0 }));
    return { sourceKey, url, frameCount: 1, fps: 1, label: file.name, durationSec: IMAGE_DURATION, ...dim };
  }

  let durationSec = DEFAULT_DURATION;
  let width = 0, height = 0;
  try {
    const m = await probeVideo(url);
    durationSec = m.durationSec;
    width = m.width;
    height = m.height;
  } catch {
    /* non-decodable → keep the defaults */
  }
  const fps = ASSUMED_FPS;
  return {
    sourceKey,
    url,
    frameCount: Math.max(1, Math.round(durationSec * fps)),
    fps,
    label: file.name,
    durationSec,
    width,
    height,
  };
}

function probeVideo(url: string): Promise<{ durationSec: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => {
      const d = v.duration;
      resolve({
        durationSec: Number.isFinite(d) && d > 0 ? d : DEFAULT_DURATION,
        width: v.videoWidth || 0,
        height: v.videoHeight || 0,
      });
    };
    v.onerror = () => reject(new Error('probe failed'));
    v.src = url;
  });
}

function probeImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onerror = () => reject(new Error('probe failed'));
    img.src = url;
  });
}
