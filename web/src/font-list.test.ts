import { describe, it, expect } from 'vitest';
import { parseFamilyList, formatFamilyList, isGenericFamily } from './font-list';

describe('parseFamilyList', () => {
  it('splits comma-separated families and trims whitespace', () => {
    expect(parseFamilyList('Arial, Helvetica , sans-serif'))
      .toEqual(['Arial', 'Helvetica', 'sans-serif']);
  });

  it('strips matching double or single quotes', () => {
    expect(parseFamilyList('"Times New Roman", \'Courier New\''))
      .toEqual(['Times New Roman', 'Courier New']);
  });

  it('keeps inner spaces of unquoted multi-word names', () => {
    expect(parseFamilyList('Hiragino Kaku Gothic ProN')).toEqual(['Hiragino Kaku Gothic ProN']);
  });

  it('drops empty tokens (trailing comma, blank entries)', () => {
    expect(parseFamilyList('Arial, , ,')).toEqual(['Arial']);
    expect(parseFamilyList('')).toEqual([]);
    expect(parseFamilyList('   ')).toEqual([]);
  });

  it('does not strip mismatched / single quotes', () => {
    expect(parseFamilyList('"Arial')).toEqual(['"Arial']);   // unmatched → kept verbatim
  });
});

describe('formatFamilyList', () => {
  it('joins with ", " and leaves simple / multi-word names unquoted', () => {
    expect(formatFamilyList(['Arial', 'Times New Roman', 'sans-serif']))
      .toBe('Arial, Times New Roman, sans-serif');
  });

  it('quotes only names containing a comma or quote', () => {
    expect(formatFamilyList(['Weird, Font'])).toBe('"Weird, Font"');
    expect(formatFamilyList(['it"s'])).toBe("'it\"s'");
  });

  it('trims and drops empty entries', () => {
    expect(formatFamilyList([' Arial ', '', '  '])).toBe('Arial');
  });
});

describe('round-trip', () => {
  for (const input of [
    'Arial, Helvetica, sans-serif',
    '"Times New Roman", Georgia',
    'Hiragino Kaku Gothic ProN, Noto Sans',
    'ヒラギノ角ゴ ProN, sans-serif',
  ]) {
    it(`format(parse(x)) preserves the family list for ${JSON.stringify(input)}`, () => {
      const fams = parseFamilyList(input);
      expect(parseFamilyList(formatFamilyList(fams))).toEqual(fams);
    });
  }
});

describe('isGenericFamily', () => {
  it('recognizes CSS generics case-insensitively', () => {
    expect(isGenericFamily('serif')).toBe(true);
    expect(isGenericFamily('Sans-Serif')).toBe(true);
    expect(isGenericFamily('monospace')).toBe(true);
    expect(isGenericFamily('Arial')).toBe(false);
  });
});
