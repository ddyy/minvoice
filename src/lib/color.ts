/** Brand accent color helpers — shared by the email templates and the PDF. */

export const DEFAULT_ACCENT = '#1e5b43'; // Ledger green

/** A safe #rgb / #rrggbb hex string, or the default if the input is malformed. */
export function safeAccent(input: string | null | undefined): string {
  const v = (input ?? '').trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : DEFAULT_ACCENT;
}

/** Hex → 0..1 RGB triple for pdf-lib's rgb(). Accepts #rgb or #rrggbb. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  let h = safeAccent(hex).slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** WCAG relative luminance of a hex color (0 black .. 1 white). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb01(hex);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whether a color can serve as the accent: it must remain visible against
 * the white email/PDF background (links and the PAID stamp render in the
 * accent directly). 2.5:1 rejects white/near-white/pale pastels while
 * admitting normal brand colors.
 */
export function accentUsable(hex: string): boolean {
  const v = (hex ?? '').trim();
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return false; // malformed: reject, don't validate the default
  return contrastRatio(v, '#ffffff') >= 2.5;
}

/** Button-text color that stays readable ON the accent: paper on dark accents, ink on light ones. */
export function accentForeground(hex: string): string {
  return contrastRatio(safeAccent(hex), '#fdfdf9') >= 3 ? '#fdfdf9' : '#1d1a15';
}
