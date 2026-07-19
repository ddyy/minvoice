import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT, hexToRgb01, safeAccent } from './color';

describe('safeAccent', () => {
  it('accepts #rgb and #rrggbb, rejects anything else', () => {
    expect(safeAccent('#1e5b43')).toBe('#1e5b43');
    expect(safeAccent('#abc')).toBe('#abc');
    expect(safeAccent('  #FF0000 ')).toBe('#FF0000');
    expect(safeAccent('red')).toBe(DEFAULT_ACCENT);
    expect(safeAccent('#12')).toBe(DEFAULT_ACCENT);
    expect(safeAccent('1e5b43')).toBe(DEFAULT_ACCENT); // no hash
    expect(safeAccent(null)).toBe(DEFAULT_ACCENT);
    expect(safeAccent('#deadbeef')).toBe(DEFAULT_ACCENT); // 8 digits
  });
});

describe('hexToRgb01', () => {
  it('converts hex to 0..1 rgb, expanding shorthand', () => {
    expect(hexToRgb01('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb01('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRgb01('#f00')).toEqual({ r: 1, g: 0, b: 0 });
    const g = hexToRgb01('#1e5b43');
    expect(g.r).toBeCloseTo(0.118, 2);
    expect(g.g).toBeCloseTo(0.357, 2);
    expect(g.b).toBeCloseTo(0.263, 2);
  });
  it('falls back to the default for garbage input', () => {
    expect(hexToRgb01('nope')).toEqual(hexToRgb01(DEFAULT_ACCENT));
  });
});

describe('contrast helpers', () => {
  it('accentUsable rejects white and pale colors, admits real brand colors', async () => {
    const { accentUsable } = await import('./color');
    expect(accentUsable('#ffffff')).toBe(false);
    expect(accentUsable('#fdfdf9')).toBe(false);
    expect(accentUsable('#ffff99')).toBe(false); // pale yellow
    expect(accentUsable('#1e5b43')).toBe(true); // default green
    expect(accentUsable('#000000')).toBe(true);
    expect(accentUsable('#cc0000')).toBe(true);
    expect(accentUsable('#0055cc')).toBe(true);
  });

  it('accentUsable rejects malformed input instead of validating the default', async () => {
    const { accentUsable } = await import('./color');
    expect(accentUsable('red')).toBe(false);
    expect(accentUsable('1e5b43')).toBe(false); // missing hash
    expect(accentUsable('')).toBe(false);
    expect(accentUsable('#12')).toBe(false);
  });

  it('accentForeground picks paper on dark accents, ink on light ones', async () => {
    const { accentForeground } = await import('./color');
    expect(accentForeground('#1e5b43')).toBe('#fdfdf9'); // dark green -> paper text
    expect(accentForeground('#000000')).toBe('#fdfdf9');
    expect(accentForeground('#ffcc00')).toBe('#1d1a15'); // bright yellow -> ink text
    expect(accentForeground('#66ddaa')).toBe('#1d1a15'); // light mint -> ink text
  });

  it('contrastRatio spans the WCAG range', async () => {
    const { contrastRatio } = await import('./color');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 1);
  });
});
