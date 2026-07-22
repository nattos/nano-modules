/**
 * bmff-meta.ts — tiny pure ISO-BMFF/QuickTime metadata reader shared by the
 * import probe (drop-import) and the DXV decoder: mvhd → duration, first
 * video trak → fps / frame count / pixel size. Codec-agnostic: it reads the
 * container index, never touches sample data. All functions operate on an
 * in-memory DataView of a moov BODY (children only, no box header).
 */

export interface ContainerMeta {
  durationSec: number;
  fps?: number;
  frameCount?: number;
  width?: number;
  height?: number;
}

export function fourcc(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

/** Iterate child atoms of v[start,end) calling visit(type, bodyStart, bodyEnd). */
export function eachAtom(
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

export function parseMoov(v: DataView): ContainerMeta | null {
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

export function parseVideoTrak(
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
