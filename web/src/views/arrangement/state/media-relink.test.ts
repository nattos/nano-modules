import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the media handle store: relinkMedia re-resolves source URLs + lib paths.
vi.mock('../workspace/media-store', () => ({
  openMediaHandle: vi.fn(),
  resolveMedia: vi.fn(),
}));
// The document-ref path resolves through handle-ref, not the media table.
vi.mock('../../../state/handle-ref', () => ({
  resolveFileRef: vi.fn(),
}));
// source.file.abs resolves through the real filesystem under Electron; here a
// stub decides which absolute paths "exist".
vi.mock('../../../state/paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../state/paths')>();
  return { ...orig, getHandleFromAbsPath: vi.fn(), openMediaSource: vi.fn(orig.openMediaSource) };
});

import { store } from './store';
import * as media from '../workspace/media-store';
import * as handleRef from '../../../state/handle-ref';
import * as paths from '../../../state/paths';

/** A browser-style file handle (no absolute path) over a tiny File. */
const fh = (name: string) =>
  ({ kind: 'file', name, getFile: async () => new File(['x'], name) }) as never;

describe('relinkMedia (video sources survive reload)', () => {
  beforeEach(() => {
    (globalThis as unknown as { URL: { createObjectURL: () => string } }).URL.createObjectURL = () => 'blob:relinked';
    vi.mocked(media.openMediaHandle).mockReset();
    vi.mocked(paths.getHandleFromAbsPath).mockReset();
    vi.mocked(paths.getHandleFromAbsPath).mockResolvedValue(undefined);
    vi.mocked(media.resolveMedia).mockReset();
    vi.mocked(handleRef.resolveFileRef).mockReset();
    vi.mocked(handleRef.resolveFileRef).mockResolvedValue(null);
    store.mediaRelPaths = {};
  });

  it('re-resolves a clip source.url from its handle + records the lib-relative path', async () => {
    const trk = store.addTrack();
    const path = store.addVideoClip(trk, 0, { sourceKey: 'k1', url: 'blob:dead', frameCount: 30, fps: 30, label: 'a.mp4' }, 4)!;
    const clipId = path.split('/')[2];

    vi.mocked(media.resolveMedia).mockResolvedValue({
      sourceKey: 'k1', ref: { kind: 'lib', libraryId: 'L', path: ['vids', 'a.mp4'] },
      name: 'a.mp4', size: 1, lastModified: 0, linkedAt: 0,
    } as never);
    vi.mocked(media.openMediaHandle).mockResolvedValue(fh('a.mp4'));

    await store.relinkMedia();

    const clip = store.trackById(trk)!.clips.find((c) => c.id === clipId)!;
    expect(clip.source!.url).toBe('blob:relinked'); // dead blob URL replaced
    expect(store.mediaRelPaths['k1']).toBe('vids/a.mp4');
  });

  it('a direct (non-library) handle relinks the URL but records no path', async () => {
    const trk = store.addTrack();
    const path = store.addVideoClip(trk, 0, { sourceKey: 'k2', url: 'blob:dead', frameCount: 30, fps: 30, label: 'b.mp4' }, 4)!;
    const clipId = path.split('/')[2];

    vi.mocked(media.resolveMedia).mockResolvedValue({
      sourceKey: 'k2', ref: { kind: 'direct', handle: {} }, name: 'b.mp4', size: 1, lastModified: 0, linkedAt: 0,
    } as never);
    vi.mocked(media.openMediaHandle).mockResolvedValue(fh('b.mp4'));

    await store.relinkMedia();

    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)!.source!.url).toBe('blob:relinked');
    expect(store.mediaRelPaths['k2']).toBeUndefined();
    expect(store.sourceMissing('k2')).toBe(false);
  });

  it('marks the source missing when the handle cannot be resolved', async () => {
    const trk = store.addTrack();
    store.addVideoClip(trk, 0, { sourceKey: 'gone', url: 'blob:dead', frameCount: 30, fps: 30, label: 'gone.mp4' }, 4);
    vi.mocked(media.resolveMedia).mockResolvedValue(null);
    vi.mocked(media.openMediaHandle).mockResolvedValue(null);

    await store.relinkMedia();

    expect(store.sourceMissing('gone')).toBe(true);
  });

  // ── the document's own ref: the binding that survives leaving this profile ──

  it('resolves from source.ref with an EMPTY media table', async () => {
    // The portability assertion: another machine has no IDB record at all, and
    // the native executor never sees one either.
    const trk = store.addTrack();
    const path = store.addVideoClip(
      trk, 0,
      { sourceKey: 'k3', url: 'blob:dead', frameCount: 30, fps: 30, label: 'c.mp4',
        ref: { libraryId: 'L', path: ['vids', 'c.mp4'] } },
      4,
    )!;
    const clipId = path.split('/')[2];

    vi.mocked(media.resolveMedia).mockResolvedValue(null); // nothing cached
    vi.mocked(media.openMediaHandle).mockResolvedValue(null);
    vi.mocked(handleRef.resolveFileRef).mockResolvedValue(fh('c.mp4'));

    await store.relinkMedia();

    // The store is a singleton across tests, so other clips relink too — look
    // for OUR ref among the calls rather than assuming an index.
    expect(vi.mocked(handleRef.resolveFileRef).mock.calls.map((c) => c[0])).toContainEqual({
      kind: 'lib', libraryId: 'L', path: ['vids', 'c.mp4'],
    });
    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)!.source!.url).toBe('blob:relinked');
    expect(store.mediaRelPaths['k3']).toBe('vids/c.mp4');
    expect(store.sourceMissing('k3')).toBe(false);
  });

  it('writes a lib ref learned from IDB back into the document', async () => {
    // So opening and re-saving a pre-ref document upgrades it in place.
    const trk = store.addTrack();
    const path = store.addVideoClip(trk, 0, { sourceKey: 'k4', url: 'blob:dead', frameCount: 30, fps: 30, label: 'd.mp4' }, 4)!;
    const clipId = path.split('/')[2];
    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)!.source!.ref).toBeUndefined();

    vi.mocked(media.resolveMedia).mockResolvedValue({
      sourceKey: 'k4', ref: { kind: 'lib', libraryId: 'L9', path: ['vids', 'd.mp4'] },
      name: 'd.mp4', size: 1, lastModified: 0, linkedAt: 0,
    } as never);
    vi.mocked(media.openMediaHandle).mockResolvedValue(fh('d.mp4'));

    await store.relinkMedia();

    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)!.source!.ref)
      .toEqual({ libraryId: 'L9', path: ['vids', 'd.mp4'] });
  });

  it('a direct-handle record writes NO ref (a handle is not serializable)', async () => {
    const trk = store.addTrack();
    const path = store.addVideoClip(trk, 0, { sourceKey: 'k5', url: 'blob:dead', frameCount: 30, fps: 30, label: 'e.mp4' }, 4)!;
    const clipId = path.split('/')[2];

    vi.mocked(media.resolveMedia).mockResolvedValue({
      sourceKey: 'k5', ref: { kind: 'direct', handle: {} }, name: 'e.mp4', size: 1, lastModified: 0, linkedAt: 0,
    } as never);
    vi.mocked(media.openMediaHandle).mockResolvedValue(fh('e.mp4'));

    await store.relinkMedia();

    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)!.source!.ref).toBeUndefined();
  });

  // ── source.file: the desktop app's binding, which needs no library ──────

  const clipOf = (trk: string, path: string) =>
    store.trackById(trk)!.clips.find((c) => c.id === path.split('/')[2])!;

  it('resolves source.file.rel beside the document before file.abs and ref', async () => {
    const trk = store.addTrack();
    const path = store.addVideoClip(trk, 0, {
      sourceKey: 'f1', url: 'blob:dead', frameCount: 30, fps: 30, label: 'f.mp4',
      file: { abs: '/old/machine/f.mp4', rel: ['media', 'f.mp4'] },
      ref: { libraryId: 'L', path: ['f.mp4'] },
    }, 4)!;
    const resolveRelative = vi.fn(async (_name: string, rel: string[]) =>
      rel.join('/') === 'media/f.mp4' ? fh('f.mp4') : null);
    const s = store as unknown as { backend: unknown; currentName: string | null };
    const [prevBackend, prevName] = [s.backend, s.currentName];
    s.backend = { resolveRelative };
    s.currentName = 'show';
    vi.mocked(media.resolveMedia).mockResolvedValue(null);
    vi.mocked(media.openMediaHandle).mockResolvedValue(null);
    try {
      await store.relinkMedia();
    } finally {
      s.backend = prevBackend;
      s.currentName = prevName;
    }
    expect(resolveRelative).toHaveBeenCalledWith('show', ['media', 'f.mp4']);
    // Found beside the document: neither the stale abs nor the library was consulted.
    expect(vi.mocked(paths.getHandleFromAbsPath)).not.toHaveBeenCalledWith('/old/machine/f.mp4');
    expect(vi.mocked(handleRef.resolveFileRef).mock.calls.map((c) => c[0]))
      .not.toContainEqual(expect.objectContaining({ libraryId: 'L', path: ['f.mp4'] }));
    expect(clipOf(trk, path).source!.url).toBe('blob:relinked');
    expect(store.sourceMissing('f1')).toBe(false);
  });

  it('falls back from a missing file.rel to file.abs, then to the ref', async () => {
    const trk = store.addTrack();
    const path = store.addVideoClip(trk, 0, {
      sourceKey: 'f2', url: 'blob:dead', frameCount: 30, fps: 30, label: 'g.mp4',
      file: { abs: '/Volumes/footage/g.mp4' },
    }, 4)!;
    vi.mocked(media.resolveMedia).mockResolvedValue(null);
    vi.mocked(media.openMediaHandle).mockResolvedValue(null);
    vi.mocked(paths.getHandleFromAbsPath).mockImplementation(async (p: string) =>
      p === '/Volumes/footage/g.mp4' ? fh('g.mp4') : undefined);

    await store.relinkMedia();

    expect(clipOf(trk, path).source!.url).toBe('blob:relinked');
    expect(store.sourceMissing('f2')).toBe(false);
  });

  it('records where the file really is once found (desktop upgrade in place)', async () => {
    // A web document opened in the desktop app: found through its library, and
    // from then on it carries the real path — no library needed next time.
    const trk = store.addTrack();
    const path = store.addVideoClip(trk, 0, {
      sourceKey: 'f3', url: 'blob:dead', frameCount: 30, fps: 30, label: 'h.mov',
      ref: { libraryId: 'L', path: ['h.mov'] },
    }, 4)!;
    vi.mocked(media.resolveMedia).mockResolvedValue(null);
    vi.mocked(media.openMediaHandle).mockResolvedValue(null);
    vi.mocked(handleRef.resolveFileRef).mockResolvedValue(fh('h.mov'));
    vi.mocked(paths.openMediaSource).mockImplementation(async (h) =>
      (h as { name: string }).name === 'h.mov'
        ? { name: 'h.mov', type: 'video/quicktime', size: 1, lastModified: 0,
            read: async () => new ArrayBuffer(0),
            url: 'nano://app/__media/%2Fdisk%2Fh.mov', absPath: '/disk/h.mov' }
        : paths.mediaSourceFromFile(await (h as { getFile(): Promise<File> }).getFile()));
    try {
      await store.relinkMedia();
    } finally {
      vi.mocked(paths.openMediaSource).mockReset();
      vi.mocked(paths.openMediaSource).mockImplementation(async (h) =>
        paths.mediaSourceFromFile(await (h as { getFile(): Promise<File> }).getFile()));
    }

    const src = clipOf(trk, path).source!;
    expect(src.url).toBe('nano://app/__media/%2Fdisk%2Fh.mov'); // streamed, not a blob
    expect(src.file).toEqual({ abs: '/disk/h.mov' });
    expect(store.mediaRelPaths['f3']).toBe('/disk/h.mov');
  });

  it('reports a library this profile has never seen, with the recorded label', async () => {
    const trk = store.addTrack();
    store.addVideoClip(trk, 0, {
      sourceKey: 'f4', url: 'blob:dead', frameCount: 30, fps: 30, label: 'i.mp4',
      ref: { libraryId: 'uuid-web-profile', path: ['i.mp4'], libraryLabel: 'Footage' },
    }, 4);
    vi.mocked(media.resolveMedia).mockResolvedValue(null);
    vi.mocked(media.openMediaHandle).mockResolvedValue(null);
    vi.mocked(handleRef.resolveFileRef).mockResolvedValue(null);

    await store.relinkMedia();

    expect(store.sourceMissing('f4')).toBe(true);
    expect(store.unknownLibraries['uuid-web-profile']).toBe('Footage');
  });
});
