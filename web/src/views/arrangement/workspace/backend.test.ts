import { describe, it, expect } from 'vitest';
import { DirectoryBackend, serializeComposition, deserializeComposition } from './backend';
import { emptyComposition, type Clip } from '../model/composition';

// ── Minimal in-memory FileSystemDirectoryHandle (only what the backend uses) ──
class MemFile {
  kind = 'file' as const;
  lastModified = 1_700_000_000_000;
  constructor(public name: string, public content = '') {}
  async getFile() { return { text: async () => this.content, lastModified: this.lastModified } as any; }
  async createWritable() {
    return {
      write: async (s: string) => { this.content = s; this.lastModified = 1_700_000_500_000; },
      close: async () => {},
    } as any;
  }
}
class MemDir {
  kind = 'directory' as const;
  children = new Map<string, MemFile | MemDir>();
  constructor(public name: string) {}
  async *values() { yield* this.children.values(); }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.children.get(name);
    if (!d) { if (!opts?.create) throw new Error('NotFoundError'); d = new MemDir(name); this.children.set(name, d); }
    if (d.kind !== 'directory') throw new Error('TypeMismatchError');
    return d as any;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.children.get(name);
    if (!f) { if (!opts?.create) throw new Error('NotFoundError'); f = new MemFile(name); this.children.set(name, f); }
    if (f.kind !== 'file') throw new Error('TypeMismatchError');
    return f as any;
  }
  async removeEntry(name: string) { this.children.delete(name); }
}

function seeded(): MemDir {
  const root = new MemDir('proj');
  root.children.set('intro.nano-arr', new MemFile('intro.nano-arr', '{}'));
  root.children.set('notes.txt', new MemFile('notes.txt', 'ignored'));
  const scenes = new MemDir('scenes');
  scenes.children.set('verse.nano-arr', new MemFile('verse.nano-arr', '{}'));
  scenes.children.set('chorus.nano-arr', new MemFile('chorus.nano-arr', '{}'));
  root.children.set('scenes', scenes);
  const hidden = new MemDir('.git');
  hidden.children.set('config.nano-arr', new MemFile('config.nano-arr', '{}'));
  root.children.set('.git', hidden);
  return root;
}

describe('DirectoryBackend', () => {
  it('lists .nano-arr files recursively, skipping non-arr + hidden dirs', async () => {
    const be = new DirectoryBackend(seeded() as any, 'proj');
    const entries = await be.list();
    expect(entries.map((e) => e.name)).toEqual(['intro', 'scenes/chorus', 'scenes/verse']);
    expect(entries.map((e) => e.dir)).toEqual(['', 'scenes', 'scenes']);
    expect(entries.find((e) => e.name === 'scenes/verse')!.fileName).toBe('verse.nano-arr');
    expect(entries[0].modified).toBe(1_700_000_000_000);
  });

  it('writes + reads a nested arrangement, creating intermediate dirs', async () => {
    const root = new MemDir('proj');
    const be = new DirectoryBackend(root as any, 'proj');
    const comp = emptyComposition();
    comp.meta.baseBPM = 99;
    await be.write('acts/one', comp);
    // The subdirectory was created and the file round-trips.
    const back = await be.read('acts/one');
    expect(back.meta.baseBPM).toBe(99);
    expect((await be.list()).map((e) => e.name)).toEqual(['acts/one']);
  });

  it('create refuses an existing name; remove deletes', async () => {
    const be = new DirectoryBackend(seeded() as any, 'proj');
    await expect(be.create('intro')).rejects.toThrow();
    await be.remove('scenes/verse');
    expect((await be.list()).map((e) => e.name)).toEqual(['intro', 'scenes/chorus']);
  });

  it('rename moves content within a directory and refuses an existing target', async () => {
    const root = seeded();
    const be = new DirectoryBackend(root as any, 'proj');
    const comp = emptyComposition();
    comp.meta.baseBPM = 77;
    await be.write('scenes/verse', comp);
    await be.rename('scenes/verse', 'scenes/bridge');
    expect((await be.list()).map((e) => e.name)).toEqual(['intro', 'scenes/bridge', 'scenes/chorus']);
    expect((await be.read('scenes/bridge')).meta.baseBPM).toBe(77);
    await expect(be.rename('intro', 'scenes/chorus')).rejects.toThrow();
  });
});

describe('composition (de)serialization', () => {
  it('round-trips the persisted loop markers (regression: deserialize dropped loop)', () => {
    const comp = emptyComposition();
    comp.loop = { enabled: false, startBeat: 4, endBeat: 20 };
    const back = deserializeComposition(serializeComposition(comp));
    expect(back.loop).toEqual({ enabled: false, startBeat: 4, endBeat: 20 });
  });

  it('leaves loop undefined for a legacy file without one', () => {
    const back = deserializeComposition(serializeComposition(emptyComposition()));
    expect(back.loop).toBeUndefined();
  });

  // ── media bindings ──
  // `source.url` is an object URL scoped to the page that made it: persisting it
  // wrote a dead pointer into every saved file. `source.ref` is what actually
  // locates the media, here and in the native executor.

  function videoClip(id: string, withRef = true): Clip {
    return {
      id,
      name: id,
      startBeat: 0,
      lengthBeat: 4,
      kind: 'video',
      sketch: { devices: [] },
      source: {
        label: id,
        durationFrames: 30,
        sourceKey: `key:${id}`,
        ...(withRef ? { ref: { libraryId: 'L1', path: ['footage', `${id}.mov`] } } : {}),
        url: `blob:${id}`,
      },
      loop: { mode: 'time', startSec: 0, speed: 1, direction: 'forward' },
      automation: [],
      exports: [],
      warps: [],
    } satisfies Clip;
  }

  it('strips the runtime blob URL and keeps the portable ref', () => {
    const comp = emptyComposition();
    comp.tracks[0].clips.push(videoClip('a'));
    const back = deserializeComposition(serializeComposition(comp));
    const src = back.tracks[0].clips[0].source!;
    expect(src.url).toBeUndefined();
    expect(src.ref).toEqual({ libraryId: 'L1', path: ['footage', 'a.mov'] });
    expect(src.sourceKey).toBe('key:a');
  });

  it('strips it inside a sequence clip s interior too', () => {
    // mediaClips recurses; a top-level-only walk left consolidated sequences
    // shipping dead urls.
    const comp = emptyComposition();
    const outer = videoClip('outer', false);
    outer.kind = 'sequence';
    outer.sequence = {
      id: 'lane1', name: 'Sequence', kind: 'track', parentId: null,
      sketch: { devices: [] }, automation: [], clips: [videoClip('inner')],
    };
    comp.tracks[0].clips.push(outer);
    const back = deserializeComposition(serializeComposition(comp));
    const inner = back.tracks[0].clips[0].sequence!.clips[0].source!;
    expect(inner.url).toBeUndefined();
    expect(inner.ref).toEqual({ libraryId: 'L1', path: ['footage', 'inner.mov'] });
  });

  it('does not mutate the live composition it serializes', () => {
    // The store keeps rendering from this object — dropping its url mid-save
    // would blank the clip.
    const comp = emptyComposition();
    comp.tracks[0].clips.push(videoClip('a'));
    serializeComposition(comp);
    expect(comp.tracks[0].clips[0].source!.url).toBe('blob:a');
  });
});
