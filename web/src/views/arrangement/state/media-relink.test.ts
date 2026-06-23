import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the media handle store: relinkMedia re-resolves source URLs + lib paths.
vi.mock('../workspace/media-store', () => ({
  openMedia: vi.fn(),
  resolveMedia: vi.fn(),
}));

import { store } from './store';
import * as media from '../workspace/media-store';

describe('relinkMedia (video sources survive reload)', () => {
  beforeEach(() => {
    (globalThis as unknown as { URL: { createObjectURL: () => string } }).URL.createObjectURL = () => 'blob:relinked';
    vi.mocked(media.openMedia).mockReset();
    vi.mocked(media.resolveMedia).mockReset();
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
});
