/**
 * Cheap, decoder-free container sniff: decide which backend a video blob needs
 * WITHOUT instantiating any WASM/decoder. The classification is purely a few KB
 * of byte reads over the container's atom chain.
 *
 * This matters because the DXV path's only way to "probe" a clip is to spin up
 * the heavy DXV decoder WASM module (its own WebAssembly.Memory) and let it
 * self-reject non-DXV streams. Doing that per clip leaks a whole linear-memory
 * instance every open and OOMs a long export ("Cannot allocate Wasm memory for
 * new instance"). Sniffing here means only genuine DXV streams ever touch that
 * module; everything else routes straight to <video>.
 */

/** DXV codec tags (DXT1/DXT5/DXD3/DXDI/DXDA/DXDC…) live as ASCII in the .mov stsd: "DX" + D|T. */
export function hasDxTag(b: Uint8Array): boolean {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0x44 /*D*/ && b[i + 1] === 0x58 /*X*/ && (b[i + 2] === 0x44 /*D*/ || b[i + 2] === 0x54 /*T*/)) return true;
  }
  return false;
}

/** The little the sniff needs of a source: its MIME type, its length, and the
 *  ability to read a byte range. Satisfied by a Blob (`blobSource`) and, without
 *  ever materialising the file, by a URL (`urlSource`). */
export interface SniffSource {
  type: string;
  size: number;
  read(start: number, end: number): Promise<ArrayBuffer>;
}

export function blobSource(blob: Blob): SniffSource {
  return {
    type: blob.type,
    size: blob.size,
    read: (start, end) => blob.slice(start, end).arrayBuffer(),
  };
}

/**
 * A ranged reader over a URL — including a `blob:` URL, which Chromium serves
 * Range requests for. Lets the sniff read a few KB out of a gigabyte file
 * instead of `fetch(url).blob()`-ing the whole thing into memory first (which
 * cost ~450 ms and a full copy per clip open on a 1 GB source).
 *
 * Falls back to reading the whole response when the server won't do ranges.
 */
export async function urlSource(url: string): Promise<SniffSource> {
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const type = probe.headers.get('content-type') ?? '';
  const cr = probe.headers.get('content-range');
  const total = cr ? Number(cr.split('/')[1]) : NaN;
  if (probe.status === 206 && Number.isFinite(total) && total > 0) {
    await probe.arrayBuffer(); // drain the 1-byte probe
    return {
      type,
      size: total,
      read: async (start, end) => {
        const r = await fetch(url, { headers: { Range: `bytes=${start}-${Math.max(start, end - 1)}` } });
        return r.arrayBuffer();
      },
    };
  }
  // No range support: fall back to one whole-file read, cached for every slice.
  const blob = await (await fetch(url)).blob();
  return blobSource(blob);
}

/** Classify a Blob. Thin wrapper over the source-based sniff. */
export function classifySource(blob: Blob): Promise<'image' | 'dxv' | 'video'> {
  return classify(blobSource(blob));
}

export async function classify(src: SniffSource): Promise<'image' | 'dxv' | 'video'> {
  if (src.type.startsWith('image/')) return 'image';
  // DXV is a QuickTime (.mov) codec, so mp4/webm/etc. are never DXV — decide them by MIME
  // alone (no read, no scan). A non-QuickTime video source skips out here.
  const t = src.type;
  if (t.startsWith('video/') && !t.includes('quicktime')) return 'video';
  // QuickTime: the DXV fourcc sits in the `moov` atom's stsd. `moov` is a SMALL metadata atom;
  // the `mdat` frame data (99% of the file) is irrelevant. So walk the top-level atom chain and
  // scan ONLY moov — never the whole file. Reading + scanning a whole clip just to sniff the
  // codec blocked the main thread ~200ms on a 150 MB clip (and ~½s on bigger ones — a real
  // playback hitch at the DXV open); walking the chain reads only a few KB + the moov atom.
  try {
    for (let pos = 0; pos + 8 <= src.size; ) {
      const hdr = new DataView(await src.read(pos, pos + 16));
      let size = hdr.getUint32(0), headerLen = 8;
      if (size === 1) { size = Number(hdr.getBigUint64(8)); headerLen = 16; } // 64-bit extended size
      else if (size === 0) size = src.size - pos; // last atom, extends to EOF
      const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
      if (type === 'moov') {
        const end = Math.min(pos + size, pos + (16 << 20)); // stsd is early in moov; cap the read
        return hasDxTag(new Uint8Array(await src.read(pos, end))) ? 'dxv' : 'video';
      }
      if (size < headerLen) break; // malformed atom → bail to the fallback
      pos += size;
    }
  } catch { /* unreadable / odd container → fall back to a cheap head sniff */ }
  const headEnd = Math.min(src.size, 4 << 20);
  return hasDxTag(new Uint8Array(await src.read(0, headEnd))) ? 'dxv' : 'video';
}
