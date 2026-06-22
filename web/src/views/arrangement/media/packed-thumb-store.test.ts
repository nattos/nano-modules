import { describe, it, expect } from 'vitest';
import { PackedThumbStore } from './packed-thumb-store';
import { MemoryBlockIO } from './block-io';
import { thumbKey } from './thumbnail-cache';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer | null): string | null => (b ? new TextDecoder().decode(new Uint8Array(b)) : null);

function makeStore(io = new MemoryBlockIO()) {
  return { io, store: new PackedThumbStore(io, { framesPerChunk: 4, flushDebounceMs: 10_000 }) };
}

describe('PackedThumbStore', () => {
  it('writes and retrieves a tile by (source, frame)', async () => {
    const { store } = makeStore();
    await store.write(thumbKey('vid', 0), enc('tile-0'));
    expect(dec(await store.read(thumbKey('vid', 0)))).toBe('tile-0');
    expect(await store.has(thumbKey('vid', 0))).toBe(true);
    expect(await store.has(thumbKey('vid', 1))).toBe(false);
    await store.flush();
  });

  it('packs frames into chunk files by frame range, retrievable across chunks', async () => {
    const { store } = makeStore(); // framesPerChunk = 4 → frames 0..3 chunk0, 8..11 chunk2
    await store.write(thumbKey('vid', 1), enc('a'));
    await store.write(thumbKey('vid', 10), enc('b'));
    expect(dec(await store.read(thumbKey('vid', 1)))).toBe('a');
    expect(dec(await store.read(thumbKey('vid', 10)))).toBe('b');
    await store.flush();
  });

  it('treats re-writing an existing tile as a no-op (immutable; no extra append)', async () => {
    const { io, store } = makeStore();
    await store.write(thumbKey('vid', 2), enc('first'));
    const writesAfterFirst = io.writes;
    await store.write(thumbKey('vid', 2), enc('second')); // same key
    expect(io.writes).toBe(writesAfterFirst); // no new append
    expect(dec(await store.read(thumbKey('vid', 2)))).toBe('first'); // original kept
    await store.flush();
  });

  it('REOPEN: a fresh store over the same BlockIO reads tiles back with no re-decode', async () => {
    const io = new MemoryBlockIO();
    const a = new PackedThumbStore(io, { framesPerChunk: 4, flushDebounceMs: 10_000 });
    for (const f of [0, 1, 5, 9]) await a.write(thumbKey('vid', f), enc(`t${f}`));
    await a.flush(); // persist indexes (the "save")

    const appendsAfterWrite = io.writes;
    const b = new PackedThumbStore(io, { framesPerChunk: 4 }); // simulate app restart
    expect(await b.has(thumbKey('vid', 5))).toBe(true);
    expect(dec(await b.read(thumbKey('vid', 5)))).toBe('t5');
    expect(dec(await b.read(thumbKey('vid', 9)))).toBe('t9');
    expect(io.writes).toBe(appendsAfterWrite); // reads only — nothing re-written/re-decoded
  });

  it('readMany returns tiles in request order', async () => {
    const { store } = makeStore();
    await store.write(thumbKey('vid', 0), enc('x'));
    await store.write(thumbKey('vid', 9), enc('z'));
    const out = await store.readMany([thumbKey('vid', 0), thumbKey('vid', 1), thumbKey('vid', 9)]);
    expect(out.map(dec)).toEqual(['x', null, 'z']);
    await store.flush();
  });

  it('clear(sourceKey) drops one source and leaves others intact', async () => {
    const { store } = makeStore();
    await store.write(thumbKey('A', 0), enc('a0'));
    await store.write(thumbKey('B', 0), enc('b0'));
    await store.flush();
    await store.clear('A');
    expect(await store.has(thumbKey('A', 0))).toBe(false);
    expect(dec(await store.read(thumbKey('B', 0)))).toBe('b0');
  });
});
