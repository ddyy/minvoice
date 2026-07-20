import { describe, expect, it } from 'vitest';
import { box, isBoxed, sealIfKeyed, unbox, validMasterKey } from './secretbox';

// 32+ chars — the minimum validMasterKey accepts
const KEY = 'unit-test-master-key-0123456789abcdef';
const OTHER_KEY = 'a-different-master-key-fedcba9876543210';

describe('validMasterKey', () => {
  it('accepts a strong key', () => {
    expect(validMasterKey(KEY)).toBe(KEY);
    expect(validMasterKey(`  ${KEY}  `)).toBe(KEY);
  });

  it('rejects short keys, placeholders, and absence', () => {
    expect(validMasterKey(undefined)).toBeUndefined();
    expect(validMasterKey('')).toBeUndefined();
    expect(validMasterKey('change-me')).toBeUndefined();
    expect(validMasterKey('x'.repeat(31))).toBeUndefined();
    expect(validMasterKey('x'.repeat(32))).toBe('x'.repeat(32));
  });
});

describe('secretbox', () => {
  it('round-trips a value', async () => {
    const boxed = await box(KEY, 'sk_live_secret');
    expect(isBoxed(boxed)).toBe(true);
    expect(boxed).not.toContain('sk_live_secret');
    expect(await unbox(KEY, boxed)).toBe('sk_live_secret');
  });

  it('produces a fresh IV per call', async () => {
    expect(await box(KEY, 'same')).not.toBe(await box(KEY, 'same'));
  });

  it('box refuses an invalid master key', async () => {
    await expect(box('change-me', 'v')).rejects.toThrow(/SETTINGS_MASTER_KEY/);
  });

  it('returns undefined for a wrong, invalid, or missing master key', async () => {
    const boxed = await box(KEY, 'sk_live_secret');
    expect(await unbox(OTHER_KEY, boxed)).toBeUndefined();
    expect(await unbox(undefined, boxed)).toBeUndefined();
    // a short or placeholder key is treated as absent, never used to decrypt
    expect(await unbox('change-me', boxed)).toBeUndefined();
    expect(await unbox('short', boxed)).toBeUndefined();
  });

  it('returns undefined for corrupted ciphertext', async () => {
    expect(await unbox(KEY, 'enc:v1:not-base64!!')).toBeUndefined();
  });

  it('passes plaintext through unchanged', async () => {
    expect(await unbox(KEY, 'sk_live_legacy')).toBe('sk_live_legacy');
    expect(await unbox(undefined, 'sk_live_legacy')).toBe('sk_live_legacy');
    expect(await unbox(KEY, '')).toBe('');
  });

  it('sealIfKeyed encrypts only under a VALID key', async () => {
    expect(await sealIfKeyed(undefined, 'v')).toBe('v');
    expect(await sealIfKeyed('', 'v')).toBe('v');
    // placeholder/short keys must NOT encrypt — publicly known key would be
    // worse than plaintext (and would silence the unencrypted warning)
    expect(await sealIfKeyed('change-me', 'v')).toBe('v');
    expect(await sealIfKeyed('short', 'v')).toBe('v');
    expect(await sealIfKeyed(KEY, '')).toBe('');
    const sealed = await sealIfKeyed(KEY, 'v');
    expect(isBoxed(sealed)).toBe(true);
    expect(await unbox(KEY, sealed)).toBe('v');
  });
});
