/**
 * Binary index for a thumbnail pack chunk: frame → byte location in the chunk's
 * data file. Compact + flat so it loads in one read and round-trips across app
 * restarts.
 *
 * Layout: [magic u32][count u32] then `count` × [frame i32][offset u32][len u32].
 */

export interface TileLoc {
  offset: number;
  len: number;
}

/** frame → location within the chunk's data file. */
export type ChunkIndex = Map<number, TileLoc>;

const MAGIC = 0x54484d31; // "THM1"
const ENTRY_BYTES = 12;

export function encodeIndex(idx: ChunkIndex): ArrayBuffer {
  const buf = new ArrayBuffer(8 + idx.size * ENTRY_BYTES);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC);
  dv.setUint32(4, idx.size);
  let o = 8;
  for (const [frame, loc] of idx) {
    dv.setInt32(o, frame);
    dv.setUint32(o + 4, loc.offset);
    dv.setUint32(o + 8, loc.len);
    o += ENTRY_BYTES;
  }
  return buf;
}

export function decodeIndex(buf: ArrayBuffer): ChunkIndex {
  const idx: ChunkIndex = new Map();
  if (buf.byteLength < 8) return idx;
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== MAGIC) return idx; // corrupt/foreign → treat as empty
  const count = dv.getUint32(4);
  let o = 8;
  for (let i = 0; i < count && o + ENTRY_BYTES <= buf.byteLength; i++) {
    const frame = dv.getInt32(o);
    const offset = dv.getUint32(o + 4);
    const len = dv.getUint32(o + 8);
    idx.set(frame, { offset, len });
    o += ENTRY_BYTES;
  }
  return idx;
}
