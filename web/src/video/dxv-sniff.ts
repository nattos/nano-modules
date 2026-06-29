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

export async function classifySource(blob: Blob): Promise<'image' | 'dxv' | 'video'> {
  if (blob.type.startsWith('image/')) return 'image';
  // DXV is a QuickTime (.mov) codec, so mp4/webm/etc. are never DXV — decide them by MIME
  // alone (no read, no scan). A non-QuickTime video blob skips out here.
  const t = blob.type;
  if (t.startsWith('video/') && !t.includes('quicktime')) return 'video';
  // QuickTime: the DXV fourcc sits in the `moov` atom's stsd. `moov` is a SMALL metadata atom;
  // the `mdat` frame data (99% of the file) is irrelevant. So walk the top-level atom chain and
  // scan ONLY moov — never the whole file. Reading + scanning a whole clip just to sniff the
  // codec blocked the main thread ~200ms on a 150 MB clip (and ~½s on bigger ones — a real
  // playback hitch at the DXV open); walking the chain reads only a few KB + the moov atom.
  try {
    for (let pos = 0; pos + 8 <= blob.size; ) {
      const hdr = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
      let size = hdr.getUint32(0), headerLen = 8;
      if (size === 1) { size = Number(hdr.getBigUint64(8)); headerLen = 16; } // 64-bit extended size
      else if (size === 0) size = blob.size - pos; // last atom, extends to EOF
      const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
      if (type === 'moov') {
        const end = Math.min(pos + size, pos + (16 << 20)); // stsd is early in moov; cap the read
        return hasDxTag(new Uint8Array(await blob.slice(pos, end).arrayBuffer())) ? 'dxv' : 'video';
      }
      if (size < headerLen) break; // malformed atom → bail to the fallback
      pos += size;
    }
  } catch { /* unreadable / odd container → fall back to a cheap head sniff */ }
  return hasDxTag(new Uint8Array(await blob.slice(0, 4 << 20).arrayBuffer())) ? 'dxv' : 'video';
}
