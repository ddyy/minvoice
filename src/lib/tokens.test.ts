import { describe, expect, it } from 'vitest';
import { newPublicToken } from './tokens';

describe('newPublicToken', () => {
  it('is 20 chars of lowercase Crockford base32 (no i/l/o/u)', () => {
    for (let i = 0; i < 100; i++) {
      expect(newPublicToken()).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{20}$/);
    }
  });

  it('does not collide across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newPublicToken());
    expect(seen.size).toBe(10_000);
  });
});
