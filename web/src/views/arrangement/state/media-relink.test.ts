import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the media handle store: relinkMedia re-resolves source URLs + lib paths.
vi.mock('../workspace/media-store', () => ({
  openMedia: vi.fn(),
  resolveMedia: vi.fn(),
}));
// The document-ref path resolves through handle-ref, not the media table.
vi.mock('../../../state/handle-ref', () => ({
  resolveFileRef: vi.fn(),
}));

import { store } from './store';
import * as media from '../workspace/media-store';
import * as handleRef from '../../../state/handle-ref';

describe('relinkMedia (video sources survive reload)', () => {
  beforeEach(() => {
    (globalThis as unknown as { URL: { createObjectURL: () => string } }).URL.createObjectURL = () => 'blob:relinked';
    vi.mocked(media.openMedia).mockReset();
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
    vi.mocked(media.openMedia).mockResolvedValue(new File(['x'], 'a.mp4') as never);

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
    vi.mocked(media.openMedia).mockResolvedValue(new File(['x'], 'b.mp4') as never);

    await store.relinkMedia();

    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)!.source!.url).toBe('blob:relinked');
    expect(store.mediaRelPaths['k2']).toBeUndefined();
    expect(store.sourceMissing('k2')).toBe(false);
  });

  it('marks the source missing when the handle cannot be resolved', async () => {
    const trk = store.addTrack();
    store.addVideoClip(trk, 0, { sourceKey: 'gone', url: 'blob:dead', frameCount: 30, fps: 30, label: 'gone.mp4' }, 4);
    vi.mocked(media.resolveMedia).mockResolvedValue(null);
    vi.mocked(media.openMedia).mockResolvedValue(null as never);

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
    vi.mocked(media.openMedia).mockResolvedValue(null as never);
    vi.mocked(handleRef.resolveFileRef).mockResolvedValue({
      getFile: async () => new File(['x'], 'c.mp4'),
    } as never);

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
    vi.mocked(media.openMedia).mockResolvedValue(new File(['x'], 'd.mp4') as never);

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
    vi.mocked(media.openMedia).mockResolvedValue(new File(['x'], 'e.mp4') as never);

    await store.relinkMedia();

    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)!.source!.ref).toBeUndefined();
  });
});
