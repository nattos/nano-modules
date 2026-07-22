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

  // Container metadata first: codec-agnostic (a DXV .mov Chrome can't DECODE
  // still has an ordinary moov atom), and it recovers the real fps/frame count
  // instead of the assumed-30 fabrication. <video> probe stays as the fallback
  // for containers we don't parse (webm, mkv, ...).
  let durationSec = 0;
  let fps = 0;
  let frameCount = 0;
  let width = 0, height = 0;
  try {
    const m = await probeContainerMetadata(file);
    if (m) {
      durationSec = m.durationSec;
      fps = m.fps ?? 0;
      frameCount = m.frameCount ?? 0;
      width = m.width ?? 0;
      height = m.height ?? 0;
    }
  } catch { /* malformed container → fall through to the <video> probe */ }
  if (!(durationSec > 0) || !(width > 0)) {
    try {
      const m = await probeVideo(url);
      if (!(durationSec > 0)) durationSec = m.durationSec;
      if (!(width > 0)) { width = m.width; height = m.height; }
    } catch { /* non-decodable → keep the defaults */ }
  }
  if (!(durationSec > 0)) durationSec = DEFAULT_DURATION;
  if (!(fps > 0)) fps = ASSUMED_FPS;
  if (!(frameCount > 0)) frameCount = Math.max(1, Math.round(durationSec * fps));
  return {
    sourceKey,
    url,
    frameCount,
    fps,
    label: file.name,
    durationSec,
    width,
    height,
  };
}

// ── ISO-BMFF / QuickTime container probe ────────────────────────────────────
// Reads ONLY atom headers at the top level (lazy File.slice — moov is often at
// the END of a non-faststart .mov and the file may be GBs), then parses the
// small moov box in memory: mvhd → duration, video trak → fps/frames/pixels.

interface ContainerMeta {
  durationSec: number;
  fps?: number;
  frameCount?: number;
  width?: number;
  height?: number;
}

/** Cap for the in-memory moov parse — a sane moov is KBs..MBs. */
const MOOV_MAX_BYTES = 64 * 1024 * 1024;

export async function probeContainerMetadata(file: File): Promise<ContainerMeta | null> {
  // Top-level atom walk: [size u32][type 4cc], size 1 → u64 largesize follows,
  // size 0 → to EOF. Bail unless the first atom is a plausible BMFF type.
  let off = 0;
  let first = true;
  while (off + 8 <= file.size) {
    const head = new DataView(await file.slice(off, Math.min(off + 16, file.size)).arrayBuffer());
    if (head.byteLength < 8) return null;
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    let headerLen = 8;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      const big = head.getBigUint64(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
      headerLen = 16;
    } else if (size === 0) {
      size = file.size - off;
    }
    if (size < headerLen) return null;
    if (first) {
      first = false;
      if (!/^(ftyp|moov|mdat|free|skip|wide|pnot|moof|styp|sidx)$/.test(type)) return null;
    }
    if (type === 'moov') {
      if (size - headerLen > MOOV_MAX_BYTES) return null;
      const body = new DataView(await file.slice(off + headerLen, off + size).arrayBuffer());
      return parseMoov(body);
    }
    off += size;
  }
  return null;
}

function fourcc(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

/** Iterate child atoms of v[start,end) calling visit(type, bodyStart, bodyEnd). */
function eachAtom(
  v: DataView, start: number, end: number,
  visit: (type: string, bodyStart: number, bodyEnd: number) => void,
) {
  let off = start;
  while (off + 8 <= end) {
    let size = v.getUint32(off);
    const type = fourcc(v, off + 4);
    let headerLen = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      const big = v.getBigUint64(off + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(big);
      headerLen = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerLen || off + size > end) return; // malformed → stop cleanly
    visit(type, off + headerLen, off + size);
    off += size;
  }
}

function parseMoov(v: DataView): ContainerMeta | null {
  let durationSec = 0;
  let fps: number | undefined;
  let frameCount: number | undefined;
  let width: number | undefined;
  let height: number | undefined;

  eachAtom(v, 0, v.byteLength, (type, s, e) => {
    if (type === 'mvhd') {
      const ver = v.getUint8(s);
      if (ver === 1) {
        const timescale = v.getUint32(s + 20);
        const duration = Number(v.getBigUint64(s + 24));
        if (timescale > 0 && duration > 0) durationSec = duration / timescale;
      } else {
        const timescale = v.getUint32(s + 12);
        const duration = v.getUint32(s + 16);
        if (timescale > 0 && duration > 0 && duration !== 0xffffffff) durationSec = duration / timescale;
      }
    } else if (type === 'trak' && fps === undefined) {
      const t = parseVideoTrak(v, s, e);
      if (t) {
        fps = t.fps;
        frameCount = t.frameCount;
        if (t.width) { width = t.width; height = t.height; }
        // A movie without a usable mvhd still gets a duration from the track.
        if (!(durationSec > 0) && t.durationSec > 0) durationSec = t.durationSec;
      }
    }
  });
  if (!(durationSec > 0)) return null;
  return { durationSec, fps, frameCount, width, height };
}

function parseVideoTrak(
  v: DataView, start: number, end: number,
): { fps?: number; frameCount?: number; durationSec: number; width?: number; height?: number } | null {
  let isVideo = false;
  let mdhdTimescale = 0;
  let mdhdDuration = 0;
  let samples = 0;
  let width: number | undefined;
  let height: number | undefined;

  eachAtom(v, start, end, (t1, s1, e1) => {
    if (t1 === 'tkhd') {
      // width/height are 16.16 fixed point at the tail of the box.
      if (e1 - s1 >= 8) {
        const w = v.getUint32(e1 - 8) / 65536;
        const h = v.getUint32(e1 - 4) / 65536;
        if (w > 0 && h > 0) { width = Math.round(w); height = Math.round(h); }
      }
    } else if (t1 === 'mdia') {
      eachAtom(v, s1, e1, (t2, s2, e2) => {
        if (t2 === 'mdhd') {
          const ver = v.getUint8(s2);
          if (ver === 1) {
            mdhdTimescale = v.getUint32(s2 + 20);
            mdhdDuration = Number(v.getBigUint64(s2 + 24));
          } else {
            mdhdTimescale = v.getUint32(s2 + 12);
            mdhdDuration = v.getUint32(s2 + 16);
          }
        } else if (t2 === 'hdlr') {
          isVideo = fourcc(v, s2 + 8) === 'vide';
        } else if (t2 === 'minf') {
          eachAtom(v, s2, e2, (t3, s3, e3) => {
            if (t3 !== 'stbl') return;
            eachAtom(v, s3, e3, (t4, s4) => {
              if (t4 !== 'stts') return;
              const entries = v.getUint32(s4 + 4);
              let n = 0;
              for (let i = 0; i < entries && s4 + 8 + i * 8 + 8 <= e3; i++) {
                n += v.getUint32(s4 + 8 + i * 8);
              }
              samples = n;
            });
          });
        }
      });
    }
  });
  if (!isVideo) return null;
  const durationSec = mdhdTimescale > 0 ? mdhdDuration / mdhdTimescale : 0;
  const fps = durationSec > 0 && samples > 0 ? samples / durationSec : undefined;
  return { fps, frameCount: samples > 0 ? samples : undefined, durationSec, width, height };
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
