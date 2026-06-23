import { describe, it, expect } from 'vitest';
import { DirectoryBackend } from './backend';
import { emptyComposition } from '../model/composition';

// ── Minimal in-memory FileSystemDirectoryHandle (only what the backend uses) ──
class MemFile {
  kind = 'file' as const;
  constructor(public name: string, public content = '') {}
  async getFile() { return { text: async () => this.content } as any; }
  async createWritable() {
    return { write: async (s: string) => { this.content = s; }, close: async () => {} } as any;
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
});
