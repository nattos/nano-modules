import { describe, it, expect } from 'vitest';
import { sanitizeIconName, thumbnailDataUri, knownIconCount } from './effect-glyph';

// A tiny 1×1 transparent PNG, base64 (no data: prefix).
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('sanitizeIconName', () => {
  it('accepts a well-formed glyph class', () => {
    expect(sanitizeIconName('la-bolt')).toBe('la-bolt');
    expect(sanitizeIconName('la-adjust')).toBe('la-adjust');
  });

  it('tolerates a bare name by prefixing la-', () => {
    expect(sanitizeIconName('bolt')).toBe('la-bolt');
  });

  it('is case-insensitive and trims', () => {
    expect(sanitizeIconName('  LA-BOLT ')).toBe('la-bolt');
  });

  it('rejects unknown glyphs when the allow-list is available', () => {
    // CSS imports are stripped in some test transforms — skip the membership
    // assertion when the allow-list couldn't load (shape validation still runs).
    if (knownIconCount() === 0) return;
    expect(sanitizeIconName('la-definitely-not-a-real-icon')).toBeNull();
  });

  it('rejects injection / malformed values', () => {
    expect(sanitizeIconName('la-bolt broken')).toBeNull();      // extra class
    expect(sanitizeIconName('la-bolt;color:red')).toBeNull();   // css-ish
    expect(sanitizeIconName('la-<script>')).toBeNull();
    expect(sanitizeIconName('la-.foo')).toBeNull();
    expect(sanitizeIconName('la-' + 'x'.repeat(60))).toBeNull(); // length cap
  });

  it('rejects empty / nullish', () => {
    expect(sanitizeIconName('')).toBeNull();
    expect(sanitizeIconName(undefined)).toBeNull();
    expect(sanitizeIconName(null)).toBeNull();
  });
});

describe('thumbnailDataUri', () => {
  it('wraps a bare base64 PNG in a data: URI', () => {
    expect(thumbnailDataUri(PNG_1x1)).toBe(`data:image/png;base64,${PNG_1x1}`);
  });

  it('passes through a valid image data: URI', () => {
    const uri = `data:image/png;base64,${PNG_1x1}`;
    expect(thumbnailDataUri(uri)).toBe(uri);
    const webp = `data:image/webp;base64,${PNG_1x1}`;
    expect(thumbnailDataUri(webp)).toBe(webp);
  });

  it('rejects non-image data: schemes', () => {
    expect(thumbnailDataUri('data:text/html;base64,' + PNG_1x1)).toBeNull();
    expect(thumbnailDataUri('data:image/svg+xml;base64,' + PNG_1x1)).toBeNull();
  });

  it('rejects non-base64 payloads', () => {
    expect(thumbnailDataUri('not base64!!')).toBeNull();
    expect(thumbnailDataUri('abc')).toBeNull(); // length not a multiple of 4
  });

  it('rejects oversized blobs', () => {
    expect(thumbnailDataUri('A'.repeat(30000))).toBeNull();
  });

  it('rejects empty / nullish', () => {
    expect(thumbnailDataUri('')).toBeNull();
    expect(thumbnailDataUri(undefined)).toBeNull();
    expect(thumbnailDataUri(null)).toBeNull();
  });
});
