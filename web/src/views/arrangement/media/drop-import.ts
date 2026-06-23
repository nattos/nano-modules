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
}

const ASSUMED_FPS = 30;
const DEFAULT_DURATION = 4;
/** Default on-timeline length for a dropped still image. */
const IMAGE_DURATION = 1;

/**
 * @param sourceKey  Caller-provided stable key. When the file came from a
 *   FileSystemFileHandle, pass the `linkMedia()` key so the source can be
 *   relinked after reload; otherwise a session-only `drop:` key is derived.
 */
export async function importVideoFile(file: File, sourceKey?: string): Promise<DroppedMedia> {
  const url = URL.createObjectURL(file);
  sourceKey ??= `drop:${file.name}:${file.size}:${file.lastModified}`;

  // A still image is a one-frame, one-second source.
  if (file.type.startsWith('image/')) {
    return { sourceKey, url, frameCount: 1, fps: 1, label: file.name, durationSec: IMAGE_DURATION };
  }

  let durationSec = DEFAULT_DURATION;
  try {
    durationSec = await probeDuration(url);
  } catch {
    /* non-decodable → keep the default length */
  }
  const fps = ASSUMED_FPS;
  return {
    sourceKey,
    url,
    frameCount: Math.max(1, Math.round(durationSec * fps)),
    fps,
    label: file.name,
    durationSec,
  };
}

function probeDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => {
      const d = v.duration;
      resolve(Number.isFinite(d) && d > 0 ? d : DEFAULT_DURATION);
    };
    v.onerror = () => reject(new Error('probe failed'));
    v.src = url;
  });
}
