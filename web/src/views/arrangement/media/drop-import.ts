/**
 * Import a dropped file as a video-clip source: an object URL + a stable
 * `sourceKey` + a probed duration/frame estimate, so the clip spans its real
 * length on the beat grid and the film strip can decode thumbnails. Best-effort —
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

export async function importVideoFile(file: File): Promise<DroppedMedia> {
  const url = URL.createObjectURL(file);
  let durationSec = DEFAULT_DURATION;
  try {
    durationSec = await probeDuration(url);
  } catch {
    /* non-decodable → keep the default length */
  }
  const fps = ASSUMED_FPS;
  return {
    sourceKey: `drop:${file.name}:${file.size}:${file.lastModified}`,
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
