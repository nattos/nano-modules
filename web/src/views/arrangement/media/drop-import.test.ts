import { describe, it, expect } from 'vitest';
import { isImageFile } from './drop-import';

describe('isImageFile', () => {
  it('detects images by MIME type', () => {
    expect(isImageFile({ type: 'image/png', name: 'x.png' })).toBe(true);
    expect(isImageFile({ type: 'image/jpeg', name: 'anything' })).toBe(true);
  });

  // The bug: FileSystem-handle drops often report an empty type → a PNG would
  // misroute to the <video> probe and lose its dimensions. Extension saves it.
  it('detects images by extension when the MIME type is empty', () => {
    expect(isImageFile({ type: '', name: 'photo.PNG' })).toBe(true);
    expect(isImageFile({ type: '', name: 'shot.jpeg' })).toBe(true);
    expect(isImageFile({ type: '', name: 'art.webp' })).toBe(true);
    expect(isImageFile({ type: 'application/octet-stream', name: 'a.gif' })).toBe(true);
  });

  it('does NOT treat videos / unknown files as images', () => {
    expect(isImageFile({ type: 'video/mp4', name: 'clip.mp4' })).toBe(false);
    expect(isImageFile({ type: '', name: 'clip.mov' })).toBe(false);
    expect(isImageFile({ type: '', name: 'noext' })).toBe(false);
  });
});
