import { describe, expect, it } from 'vitest';
import { formatCentsTag, formatDateTag, getStrings, resolveLocale, SUPPORTED_LOCALES } from './index';
import { en } from './en';

describe('locale registry', () => {
  it('every built-in locale implements every key with a non-empty value', () => {
    for (const { tag } of SUPPORTED_LOCALES) {
      const t = getStrings(tag) as unknown as Record<string, unknown>;
      for (const key of Object.keys(en)) {
        const v = t[key];
        if (typeof v === 'string') expect(v.length, `${tag}.${key}`).toBeGreaterThan(0);
        else expect(typeof v, `${tag}.${key}`).toBe('function');
      }
    }
  });

  it('regional tags resolve to their base language, unknown languages to English', () => {
    expect(getStrings('de-AT').invoice).toBe('Rechnung');
    expect(getStrings('fr-CA').invoice).toBe('Facture');
    expect(getStrings('pl').invoice).toBe('Invoice'); // no Polish strings yet
    expect(getStrings('').invoice).toBe('Invoice');
  });

  it('resolveLocale prefers the client override', () => {
    expect(resolveLocale('en', 'de')).toBe('de');
    expect(resolveLocale('de', null)).toBe('de');
    expect(resolveLocale('de', '  ')).toBe('de');
    expect(resolveLocale('', null)).toBe('en');
  });
});

describe('Intl formatting', () => {
  it('formats dates per region', () => {
    expect(formatDateTag('2026-07-18', 'de')).toBe('18.07.2026');
    expect(formatDateTag('2026-07-18', 'en-US')).toBe('Jul 18, 2026');
  });

  it('formats currency per region', () => {
    // German EUR: 1.234,56 € (non-breaking spaces vary by ICU — compare loosely)
    const de = formatCentsTag(123456, 'EUR', 'de');
    expect(de).toContain('1.234,56');
    expect(de).toContain('€');
    const us = formatCentsTag(123456, 'USD', 'en-US');
    expect(us).toBe('$1,234.56');
  });

  it('falls back instead of throwing on a bad tag', () => {
    expect(formatDateTag('2026-07-18', 'no-such-tag-x!')).toBe('2026-07-18');
    expect(formatCentsTag(100, 'USD', 'no-such-tag-x!')).toContain('1.00');
  });
});
