import { describe, expect, it } from 'vitest';
import { box, isBoxed, sealIfKeyed, unbox } from './secretbox';

describe('secretbox', () => {
  it('round-trips a value', async () => {
    const boxed = await box('master-key', 'sk_live_secret');
    expect(isBoxed(boxed)).toBe(true);
    expect(boxed).not.toContain('sk_live_secret');
    expect(await unbox('master-key', boxed)).toBe('sk_live_secret');
  });

  it('produces a fresh IV per call', async () => {
    expect(await box('k', 'same')).not.toBe(await box('k', 'same'));
  });

  it('returns undefined for a wrong or missing master key', async () => {
    const boxed = await box('master-key', 'sk_live_secret');
    expect(await unbox('other-key', boxed)).toBeUndefined();
    expect(await unbox(undefined, boxed)).toBeUndefined();
  });

  it('returns undefined for corrupted ciphertext', async () => {
    expect(await unbox('k', 'enc:v1:not-base64!!')).toBeUndefined();
  });

  it('passes plaintext through unchanged', async () => {
    expect(await unbox('k', 'sk_live_legacy')).toBe('sk_live_legacy');
    expect(await unbox(undefined, 'sk_live_legacy')).toBe('sk_live_legacy');
    expect(await unbox('k', '')).toBe('');
  });

  it('sealIfKeyed encrypts only when a key exists', async () => {
    expect(await sealIfKeyed(undefined, 'v')).toBe('v');
    expect(await sealIfKeyed('', 'v')).toBe('v');
    expect(await sealIfKeyed('k', '')).toBe('');
    const sealed = await sealIfKeyed('k', 'v');
    expect(isBoxed(sealed)).toBe(true);
    expect(await unbox('k', sealed)).toBe('v');
  });
});
